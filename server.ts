import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { Server } from "socket.io";
import { GoogleGenAI, Type } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Initialize Gemini AI Client on the server side
  const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      })
    : null;

  // Active Online Responders Registry
  interface OnlineResponder {
    id: string;
    socketId: string;
    callSign: string;
    apparatus: "ambulance" | "police" | "fire";
    status: "waiting" | "en_route" | "on_scene" | "transporting" | "offline";
    coords: [number, number];
    accuracy?: number;
    phone?: string;
    lastSeen: number;
    isStationStandby?: boolean;
  }

  const onlineResponders: Map<string, OnlineResponder> = new Map();

  function getActiveRespondersList(refCoords?: [number, number]): OnlineResponder[] {
    const now = Date.now();
    const active: OnlineResponder[] = [];
    for (const [id, r] of onlineResponders.entries()) {
      // Retain responder for up to 10 minutes (600,000ms) between heartbeats for mobile/background stability
      if (now - r.lastSeen <= 600000 && r.status !== 'offline') {
        let coords = r.coords;
        if ((!coords || (coords[0] === 0 && coords[1] === 0)) && refCoords && refCoords[0] !== 0) {
          coords = [refCoords[0] + 0.005, refCoords[1] + 0.005];
        } else if (!coords || (coords[0] === 0 && coords[1] === 0)) {
          coords = [14.5995, 120.9842];
        }
        active.push({ ...r, coords });
      } else if (now - r.lastSeen > 900000) {
        onlineResponders.delete(id);
      }
    }
    return active;
  }

  // Socket.io Real-time Presence & Tactical Messaging
  io.on("connection", (socket) => {
    // Send immediate fleet sync upon connection
    socket.emit("responders-sync", getActiveRespondersList());

    // Responder registers presence & live GPS coordinates
    socket.on("responder-presence", (data) => {
      const respId = data.id || `resp-${data.apparatus || 'unit'}`;
      const responder: OnlineResponder = {
        id: respId,
        socketId: socket.id,
        callSign: data.callSign || (data.apparatus === 'police' ? 'Patrol Cruiser' : data.apparatus === 'fire' ? 'Rescue Engine' : 'Medic Squad'),
        apparatus: data.apparatus || "ambulance",
        status: data.status || "waiting",
        coords: data.coords || [0, 0],
        accuracy: data.accuracy,
        phone: data.phone || "",
        lastSeen: Date.now()
      };
      onlineResponders.set(respId, responder);
      io.emit("responders-sync", getActiveRespondersList());
    });

    // Real-time two-way tactical incident messaging
    socket.on("send-incident-message", (data) => {
      if (data && data.incidentId) {
        if (!incidentMessages[data.incidentId]) incidentMessages[data.incidentId] = [];
        const msg = {
          id: data.message?.id || "msg-" + Date.now(),
          sender: data.message?.sender || "citizen",
          senderName: data.message?.senderName || "User",
          text: data.message?.text || "",
          timestamp: data.message?.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isUrgent: Boolean(data.message?.isUrgent)
        };
        incidentMessages[data.incidentId].push(msg);
        io.emit("incident-message", { incidentId: data.incidentId, message: msg });
      }
    });

    socket.on("disconnect", () => {
      // Retain responder in presence registry with grace period; emit current active list
      io.emit("responders-sync", getActiveRespondersList());
    });
  });

  // Middlewares
  app.use(express.json());
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Active Incidents Store
  interface Incident {
    id: string;
    code: string;
    type: string;
    priority: "critical" | "urgent" | "standard";
    location: string;
    reportedTime: string;
    patientName: string;
    recommendedUnit: string;
    service?: "ambulance" | "police" | "fire";
    targetResponderId?: string;
    acceptedUnit?: string;
    acceptedUnitId?: string;
    declinedBy?: string[];
    distanceKm: number;
    etaMins: number;
    routeAlgorithm: string;
    status: "pending" | "dispatched" | "en_route" | "on_scene" | "cancelled" | "completed";
    coords: [number, number];
    details?: string;
    createdAt: string;
    isGeneralSos?: boolean;
  }

  function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // meters
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const deltaP = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(deltaP / 2) * Math.sin(deltaP / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  const liveIncidents: Incident[] = [];

  // Incident Comms / Chat Messages Store
  const incidentMessages: Record<string, Array<{ id: string; sender: string; senderName: string; text: string; timestamp: string; isUrgent?: boolean }>> = {};

  // 1. Health Endpoint
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      backend: "express",
      platform: "Node.js Express / Vite",
      timestamp: new Date().toISOString(),
      activeIncidents: liveIncidents.length,
      serverUptimeSec: Math.floor(process.uptime()),
      serviceStatus: "ONLINE",
      geminiAiActive: Boolean(ai)
    });
  });

  // 2. Incident Management Endpoints
  app.get("/api/incidents", (_req, res) => {
    res.json({
      success: true,
      count: liveIncidents.length,
      data: liveIncidents
    });
  });

  app.post("/api/incidents", (req, res) => {
    const { id, type, location, priority, patientName, coords, details, service, targetResponderId, recommendedUnit, isGeneralSos } = req.body;
    const activeFleet = getActiveRespondersList(coords && coords[0] ? coords : undefined);

    // Reject dispatch if no responders are currently online
    if (activeFleet.length === 0) {
      res.status(400).json({
        success: false,
        message: "No emergency responders are currently online. Cannot dispatch.",
        noResponders: true
      });
      return;
    }

    const newId = id || `INC-${Math.floor(1000 + Math.random() * 9000)}`;
    const isSos = Boolean(isGeneralSos || type?.toLowerCase().includes("sos") || type?.toLowerCase().includes("general"));
    
    let resolvedService: "ambulance" | "police" | "fire" = service || "ambulance";
    let resolvedTargetResponderId = targetResponderId;
    let resolvedRecommendedUnit = recommendedUnit;

    if (isSos) {
      // Home screen SOS button activated: dispatch the nearest unit of ANY service
      const sortedFleet = [...activeFleet].sort((a, b) => {
        if (!coords || !coords[0]) return 0;
        const da = calculateDistance(coords[0], coords[1], a.coords[0], a.coords[1]);
        const db = calculateDistance(coords[0], coords[1], b.coords[0], b.coords[1]);
        return da - db;
      });

      const nearestUnit = sortedFleet[0];
      resolvedService = nearestUnit.apparatus;
      resolvedTargetResponderId = targetResponderId || nearestUnit.id;
      resolvedRecommendedUnit = recommendedUnit || nearestUnit.callSign;
    } else {
      // Map screen or specific service dispatch: only the selected/specified responder
      if (service) {
        resolvedService = service;
      } else if (type?.toLowerCase().includes("police")) {
        resolvedService = "police";
      } else if (type?.toLowerCase().includes("fire")) {
        resolvedService = "fire";
      }

      if (!resolvedTargetResponderId) {
        // Find matching units in the chosen service
        const serviceUnits = activeFleet.filter(r => r.apparatus === resolvedService);
        if (serviceUnits.length > 0) {
          if (coords && coords[0]) {
            serviceUnits.sort((a, b) => {
              const da = calculateDistance(coords[0], coords[1], a.coords[0], a.coords[1]);
              const db = calculateDistance(coords[0], coords[1], b.coords[0], b.coords[1]);
              return da - db;
            });
          }
          resolvedTargetResponderId = serviceUnits[0].id;
          resolvedRecommendedUnit = serviceUnits[0].callSign;
        }
      } else {
        const found = activeFleet.find(r => r.id === resolvedTargetResponderId);
        if (found) {
          resolvedRecommendedUnit = found.callSign;
          resolvedService = found.apparatus;
        }
      }
    }

    const defaultUnitName = resolvedRecommendedUnit || (
      resolvedService === "police" ? "Police Emergency Unit" :
      resolvedService === "fire" ? "Fire & Rescue Unit" : "EMS Paramedic Unit"
    );

    const newIncident: Incident = {
      id: newId,
      code: "10-79",
      type: type || (isSos ? "Emergency SOS Alert" : `Emergency Dispatch Alert (${resolvedService.toUpperCase()})`),
      priority: priority || "critical",
      location: location || "GPS Location Reported",
      reportedTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      patientName: patientName || "Citizen Caller",
      service: resolvedService,
      targetResponderId: resolvedTargetResponderId || undefined,
      recommendedUnit: defaultUnitName,
      distanceKm: 0,
      etaMins: 0,
      routeAlgorithm: "OSRM Road Network / Dijkstra",
      status: "dispatched",
      coords: coords || [0, 0],
      details: details || "",
      declinedBy: [],
      createdAt: new Date().toISOString(),
      isGeneralSos: isSos
    };

    liveIncidents.unshift(newIncident);

    // Broadcast only to targeted responder (or to fleet with target filter) via WebSockets
    io.emit("incoming-call", {
      citizenId: newId,
      id: newId,
      callerName: newIncident.patientName,
      location: newIncident.location,
      type: newIncident.type,
      service: newIncident.service,
      targetResponderId: newIncident.targetResponderId,
      recommendedUnit: newIncident.recommendedUnit,
      isGeneralSos: newIncident.isGeneralSos
    });

    io.emit("incident-dispatched", newIncident);

    res.status(201).json({
      success: true,
      message: "Emergency incident dispatched successfully",
      data: newIncident
    });
  });

  app.get("/api/incidents/:id", (req, res) => {
    const item = liveIncidents.find(i => i.id === req.params.id);
    if (!item) {
      res.status(404).json({ success: false, message: "Incident not found" });
      return;
    }
    res.json({ success: true, data: item });
  });

  app.patch("/api/incidents/:id/status", (req, res) => {
    const { status, acceptedUnit, acceptedUnitId, coords, apparatus } = req.body;
    const item = liveIncidents.find(i => i.id === req.params.id);
    if (!item) {
      // Broadcast update even if created via direct Firestore fallback
      io.emit("incident-updated", { id: req.params.id, status });
      if (status === 'en_route') {
        io.emit("incident-accepted", {
          incidentId: req.params.id,
          status: 'en_route',
          responder: {
            id: acceptedUnitId || "responder",
            callSign: acceptedUnit || "Assigned Unit",
            apparatus: apparatus || "ambulance",
            coords: coords || [0, 0]
          }
        });
      }
      res.json({ success: true, data: { id: req.params.id, status } });
      return;
    }

    if (status) {
      item.status = status;
      if (status === 'en_route') {
        item.acceptedUnit = acceptedUnit || item.acceptedUnit || item.recommendedUnit;
        item.acceptedUnitId = acceptedUnitId || item.acceptedUnitId || item.targetResponderId;
        
        io.emit("incident-accepted", {
          incidentId: item.id,
          status: 'en_route',
          responder: {
            id: item.acceptedUnitId || "unit",
            callSign: item.acceptedUnit || item.recommendedUnit,
            apparatus: item.service || apparatus || "ambulance",
            coords: coords || item.coords
          }
        });
      }
      io.emit("incident-updated", item);
    }
    res.json({ success: true, data: item });
  });

  // Decline incident:
  // - If General SOS from Home screen: cascade to next nearest unit of ANY service
  // - If specific service from Map screen: cascade to next unit in the SAME service
  app.post("/api/incidents/:id/decline", (req, res) => {
    const { responderId, callSign, apparatus } = req.body;
    const item = liveIncidents.find(i => i.id === req.params.id);
    if (!item) {
      res.status(404).json({ success: false, message: "Incident not found" });
      return;
    }

    item.declinedBy = item.declinedBy || [];
    if (responderId && !item.declinedBy.includes(responderId)) {
      item.declinedBy.push(responderId);
    }
    if (callSign && !item.declinedBy.includes(callSign)) {
      item.declinedBy.push(callSign);
    }

    const fleet = getActiveRespondersList(item.coords && item.coords[0] ? item.coords : undefined);

    // Broadcast that this unit declined
    io.emit("incident-declined", {
      incidentId: item.id,
      declinedBy: callSign || responderId || "Unit",
      apparatus: item.service || apparatus || "ambulance"
    });

    if (item.isGeneralSos) {
      // Home Screen SOS: cascade to the next nearest unit of ANY service
      const candidateUnits = fleet.filter(r => 
        r.status !== 'offline' &&
        !item.declinedBy!.includes(r.id) &&
        !item.declinedBy!.includes(r.callSign)
      );

      if (candidateUnits.length > 0) {
        if (item.coords && item.coords[0]) {
          candidateUnits.sort((a, b) => {
            const da = calculateDistance(item.coords[0], item.coords[1], a.coords[0], a.coords[1]);
            const db = calculateDistance(item.coords[0], item.coords[1], b.coords[0], b.coords[1]);
            return da - db;
          });
        }

        const nextUnit = candidateUnits[0];
        item.recommendedUnit = nextUnit.callSign;
        item.targetResponderId = nextUnit.id;
        item.service = nextUnit.apparatus;
        item.status = "dispatched";

        io.emit("incident-reassigned", {
          incidentId: item.id,
          previousUnit: callSign || responderId || "Previous Unit",
          nextUnit: {
            id: nextUnit.id,
            callSign: nextUnit.callSign,
            apparatus: nextUnit.apparatus,
            coords: nextUnit.coords,
            status: nextUnit.status
          },
          service: nextUnit.apparatus,
          isGeneralSos: true
        });

        io.emit("incoming-call", {
          citizenId: item.id,
          id: item.id,
          callerName: item.patientName,
          location: item.location,
          type: item.type,
          service: nextUnit.apparatus,
          targetResponderId: nextUnit.id,
          recommendedUnit: nextUnit.callSign,
          isGeneralSos: true
        });

        io.emit("incident-updated", item);

        res.json({
          success: true,
          message: `SOS incident auto-reassigned to next nearest unit: ${nextUnit.callSign} (${nextUnit.apparatus})`,
          reassignedTo: nextUnit,
          isGeneralSos: true
        });
        return;
      } else {
        io.emit("incident-declined-all", {
          incidentId: item.id,
          service: "any",
          isGeneralSos: true
        });

        res.json({
          success: true,
          message: "All online emergency units across all services have declined or are busy.",
          allDeclined: true
        });
        return;
      }
    }

    // Specific Service Incident (MapScreen): cascade to next unit in the SAME SERVICE
    const serviceType = item.service || apparatus || "ambulance";
    const candidateUnits = fleet.filter(r => 
      r.apparatus === serviceType &&
      r.status !== 'offline' &&
      !item.declinedBy!.includes(r.id) &&
      !item.declinedBy!.includes(r.callSign)
    );

    if (candidateUnits.length > 0) {
      if (item.coords && item.coords[0]) {
        candidateUnits.sort((a, b) => {
          const da = calculateDistance(item.coords[0], item.coords[1], a.coords[0], a.coords[1]);
          const db = calculateDistance(item.coords[0], item.coords[1], b.coords[0], b.coords[1]);
          return da - db;
        });
      }

      const nextUnit = candidateUnits[0];
      item.recommendedUnit = nextUnit.callSign;
      item.targetResponderId = nextUnit.id;
      item.status = "dispatched";

      io.emit("incident-reassigned", {
        incidentId: item.id,
        previousUnit: callSign || responderId || "Previous Unit",
        nextUnit: {
          id: nextUnit.id,
          callSign: nextUnit.callSign,
          apparatus: nextUnit.apparatus,
          coords: nextUnit.coords,
          status: nextUnit.status
        },
        service: serviceType,
        isGeneralSos: false
      });

      io.emit("incoming-call", {
        citizenId: item.id,
        id: item.id,
        callerName: item.patientName,
        location: item.location,
        type: item.type,
        service: item.service,
        targetResponderId: nextUnit.id,
        recommendedUnit: nextUnit.callSign,
        isGeneralSos: false
      });

      io.emit("incident-updated", item);

      res.json({
        success: true,
        message: `Incident auto-reassigned to next available unit in same service: ${nextUnit.callSign}`,
        reassignedTo: nextUnit,
        isGeneralSos: false
      });
    } else {
      io.emit("incident-declined-all", {
        incidentId: item.id,
        service: serviceType,
        isGeneralSos: false
      });

      res.json({
        success: true,
        message: `All available ${serviceType} units have been contacted and are currently occupied.`,
        allDeclined: true
      });
    }
  });

  // Incident Comms / Chat Messages Store
  app.get("/api/incidents/:id/messages", (req, res) => {
    const list = incidentMessages[req.params.id] || [];
    res.json({ success: true, data: list });
  });

  app.post("/api/incidents/:id/messages", (req, res) => {
    const { sender, senderName, text, isUrgent } = req.body;
    if (!incidentMessages[req.params.id]) {
      incidentMessages[req.params.id] = [];
    }
    const newMsg = {
      id: "msg-" + Date.now(),
      sender: sender || "responder",
      senderName: senderName || "Responder",
      text: text || "",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isUrgent: Boolean(isUrgent)
    };
    incidentMessages[req.params.id].push(newMsg);
    io.emit("incident-message", { incidentId: req.params.id, message: newMsg });
    res.status(201).json({ success: true, data: newMsg });
  });

  // Direct Messenger Comms (Direct Citizen <-> Responder Chat)
  app.post("/api/direct-chats/message", (req, res) => {
    const { chatId, message, chat } = req.body;
    io.emit("direct-message", { chatId, message, chat });
    res.json({ success: true });
  });

  // 3. Real Server-Side Gemini AI Chat & Emergency Triage Assistant
  app.post("/api/chat", async (req, res) => {
    const { messages, context } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ success: false, error: "Messages array is required." });
      return;
    }

    if (!ai) {
      res.status(503).json({
        success: false,
        error: "Gemini AI service is initializing or API key is not configured.",
        text: "I am Serdy, your emergency response triage assistant. If you are experiencing a life-threatening medical emergency, active fire, or violent crime, please immediately trigger the Emergency SOS button."
      });
      return;
    }

    try {
      const userContextSnippet = context ? `
User Context:
- Caller Name: ${context.callerName || "Unknown"}
- Address / Location: ${context.location || "Not specified"}
- Blood Type: ${context.bloodType || "Unknown"}
- Known Allergies: ${Array.isArray(context.allergies) && context.allergies.length > 0 ? context.allergies.join(", ") : "None reported"}
` : "";

      const systemInstruction = `You are Serdy, the clinical Smart Emergency Response Dispatch (SERD) AI triage assistant.
Your mission is to rapidly evaluate emergency situations, triage severity using universal emergency triage standards (P1 Critical through P4 Non-Urgent), give clear step-by-step life preservation instructions, and determine required emergency services.

Triage Standards:
- P1_CRITICAL: Immediate life threat (respiratory failure, cardiac arrest, severe hemorrhage, unconsciousness, stroke, major trauma, active structure fire, violent assault).
- P2_URGENT: Serious condition requiring rapid dispatch (fractures with pulse, controlled deep laceration, head trauma with consciousness, smoke inhalation).
- P3_MODERATE: Non-life-threatening medical or minor security issues (minor burns, sprains, stable symptoms).
- P4_NON_URGENT: General first-aid questions or minor conditions that do not require emergency dispatch.

Rules:
1. Speak in a calm, decisive, reassuring tone.
2. If dispatch is needed, designate the correct service: 'ambulance', 'police', or 'fire'.
3. Always provide concrete, numbered, immediate first-aid actions (e.g. "1. Apply firm, direct pressure...", "2. Keep patient lying down...").
4. Check caller known allergies and situation risks for safety precautions.
5. If situation is minor or self-limiting, reassure the user and state self-care guidelines without false alarm.
${userContextSnippet}`;

      // Convert message history to format expected by @google/genai
      const contents = messages.map((m: any) => ({
        role: m.role === 'bot' || m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text }]
      }));

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents,
        config: {
          systemInstruction,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              guidance: {
                type: Type.STRING,
                description: "Conversational, calm, professional guidance from Serdy to the caller."
              },
              urgency: {
                type: Type.STRING,
                description: "One of: P1_CRITICAL, P2_URGENT, P3_MODERATE, P4_NON_URGENT"
              },
              urgencyLabel: {
                type: Type.STRING,
                description: "Short human label: e.g. 'P1 - Critical', 'P2 - Urgent', 'P3 - Moderate', 'P4 - Non-Urgent'"
              },
              chiefComplaint: {
                type: Type.STRING,
                description: "Concise emergency summary (e.g. 'Acute Chest Pain', 'Severe Bleeding', 'Residential Fire')"
              },
              dispatchNeeded: {
                type: Type.BOOLEAN,
                description: "True if emergency unit dispatch is needed"
              },
              recommendedService: {
                type: Type.STRING,
                description: "One of: 'ambulance', 'police', 'fire', 'none'"
              },
              dispatchLabel: {
                type: Type.STRING,
                description: "Button label, e.g. 'Dispatch Ambulance', 'Dispatch Police', 'Dispatch Fire & Rescue'"
              },
              firstAidSteps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Ordered, concrete first aid steps for the user to follow right now."
              },
              precautions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Crucial clinical precautions, allergy warnings, or environmental hazards."
              }
            },
            required: ["guidance", "urgency", "urgencyLabel", "chiefComplaint", "dispatchNeeded", "recommendedService", "firstAidSteps"]
          }
        }
      });

      let parsed: any = null;
      try {
        parsed = JSON.parse(response.text || "{}");
      } catch (parseErr) {
        console.warn("[Gemini API] Failed to parse triage JSON, using text fallback:", parseErr);
      }

      if (parsed && parsed.guidance) {
        // Construct legacy action tag for full backwards compatibility
        let combinedText = parsed.guidance;
        if (parsed.dispatchNeeded && parsed.dispatchLabel) {
          combinedText += `\n\n[ACTION: ${parsed.dispatchLabel}]`;
        }

        res.json({
          success: true,
          text: combinedText,
          guidance: parsed.guidance,
          triage: {
            urgency: parsed.urgency,
            urgencyLabel: parsed.urgencyLabel,
            chiefComplaint: parsed.chiefComplaint,
            dispatchNeeded: parsed.dispatchNeeded,
            recommendedService: parsed.recommendedService === 'none' ? undefined : parsed.recommendedService,
            dispatchLabel: parsed.dispatchLabel,
            firstAidSteps: parsed.firstAidSteps || [],
            precautions: parsed.precautions || []
          }
        });
        return;
      }

      const fallbackText = response.text || "I have received your situation details. Please remain safe.";
      res.json({
        success: true,
        text: fallbackText
      });
    } catch (err: any) {
      console.error("[Gemini API] Chat triage error:", err);
      res.status(500).json({
        success: false,
        error: err.message || "Failed to generate AI triage response.",
        text: "I am experiencing high network load. If you are in immediate danger, please trigger the Emergency SOS button."
      });
    }
  });



  // 5. Real-time Emergency Units Telemetry & Online Responders
  app.get("/api/responders/online", (req, res) => {
    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
    const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;
    const refCoords = (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) ? [lat, lng] as [number, number] : undefined;
    const list = getActiveRespondersList(refCoords);
    res.json({
      success: true,
      count: list.length,
      data: list
    });
  });

  app.post("/api/responders/presence", (req, res) => {
    const data = req.body;
    const respId = data.id || `resp-${data.apparatus || 'unit'}`;
    const responder: OnlineResponder = {
      id: respId,
      socketId: data.socketId || 'http-client',
      callSign: data.callSign || (data.apparatus === 'police' ? 'Patrol Cruiser' : data.apparatus === 'fire' ? 'Rescue Engine' : 'Medic Squad'),
      apparatus: data.apparatus || 'ambulance',
      status: data.status || 'waiting',
      coords: data.coords || [0, 0],
      accuracy: data.accuracy,
      phone: data.phone || '',
      lastSeen: Date.now()
    };
    onlineResponders.set(respId, responder);
    io.emit("responders-sync", getActiveRespondersList());
    res.json({ success: true, data: responder });
  });

  app.get("/api/telemetry/units", (req, res) => {
    const units = getActiveRespondersList().map(r => ({
      id: r.id,
      name: r.callSign,
      type: r.apparatus,
      status: r.status,
      coords: r.coords
    }));
    res.json({
      success: true,
      units
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true' ? { server: httpServer } : false
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
