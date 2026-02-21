require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(express.json({ limit: '1mb' }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  })
);

const SCENARIOS = [
  {
    scenarioId: 's1',
    displayName: 'Morning commute',
    timeOfDay: 'day',
    userAlone: false,
    neighborhoodType: 'downtown',
    routeLighting: 'good',
  },
  {
    scenarioId: 's2',
    displayName: 'Late night walk',
    timeOfDay: 'night',
    userAlone: true,
    neighborhoodType: 'residential',
    routeLighting: 'poor',
  },
  {
    scenarioId: 's3',
    displayName: 'Evening shift exit',
    timeOfDay: 'night',
    userAlone: false,
    neighborhoodType: 'industrial',
    routeLighting: 'mixed',
  },
  {
    scenarioId: 's4',
    displayName: 'Afternoon stroll',
    timeOfDay: 'day',
    userAlone: true,
    neighborhoodType: 'residential',
    routeLighting: 'good',
  },
  {
    scenarioId: 's5',
    displayName: 'Late evening errand',
    timeOfDay: 'night',
    userAlone: true,
    neighborhoodType: 'downtown',
    routeLighting: 'mixed',
  },
];

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'memory.json');
let MEMORY = { hasMemory: false, lastLowScenarioId: null, lastSaferAction: null };

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        MEMORY = {
          hasMemory: Boolean(parsed.hasMemory),
          lastLowScenarioId: parsed.lastLowScenarioId || null,
          lastSaferAction: parsed.lastSaferAction || null,
        };
      }
    }
  } catch (err) {
    console.error('Failed to load memory.json:', err && err.message ? err.message : err);
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(MEMORY, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save memory.json:', err && err.message ? err.message : err);
  }
}

// Load memory on startup
loadMemory();

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/scenarios', (req, res) => {
  res.json(SCENARIOS);
});

app.get('/api/memory-echo', (req, res) => {
  res.json(MEMORY);
});

app.get('/api/tts', (req, res) => {
  res.json({
    ok: true,
    note: 'Use POST /api/tts with body { text } to generate audio or fallback JSON.',
   exampleCurl: "curl -Method POST http://localhost:8080/api/tts -ContentType \"application/json\" -Body '{\"text\":\"hello\"}'"
  });
});
app.get('/api/docs', (req, res) => {
  res.json({
    endpoints: [
      {
        method: 'GET',
        path: '/health',
        description: 'Liveness check',
        responseExample: { ok: true, ts: 1670000000000 },
      },
      {
        method: 'GET',
        path: '/api/scenarios',
        description: 'List preset scenarios',
        responseExample: [{ scenarioId: 's1', displayName: 'Morning commute' }],
      },
      {
        method: 'POST',
        path: '/api/risk-assess',
        description: 'Assess risk for a scenario (uses Gemini or fallback)',
        requestExample: { scenarioId: 's1', timeOfDay: 'day', userAlone: false, neighborhoodType: 'residential', routeLighting: 'good' },
        responseExample: { riskScore: 12, riskLevel: 'LOW', reasoning: '...', guardianMessage: '...', saferAction: '...' },
      },
      {
        method: 'GET',
        path: '/api/memory-echo',
        description: 'Return last saved low-risk memory (if any)',
        responseExample: { hasMemory: false, lastLowScenarioId: null, lastSaferAction: null },
      },
      {
        method: 'GET',
        path: '/api/tts',
        description: 'TTS usage info (call POST /api/tts to generate audio)',
        responseExample: { ok: true, note: 'Use POST /api/tts with body { text }...' },
      },
      {
        method: 'POST',
        path: '/api/tts',
        description: 'Generate speech audio or return safe fallback JSON',
        requestExample: { text: 'Hello' },
        responseExample: 'audio/mpeg bytes OR { ok:false, fallback:true, provider:"browser_tts", text: "...", reason: "elevenlabs_unavailable" }',
      },
    ],
  });
});

// In-memory rate limiter
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 30; // requests per window
const rateLimitStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip;
}

function rateLimitMiddleware(req, res, next) {
  try {
    const ip = getClientIp(req) || 'unknown';
    const now = Date.now();
    const entry = rateLimitStore.get(ip);

    if (!entry) {
      rateLimitStore.set(ip, { count: 1, start: now });
      return next();
    }

    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
      // reset window
      rateLimitStore.set(ip, { count: 1, start: now });
      return next();
    }

    entry.count += 1;
    rateLimitStore.set(ip, entry);

    if (entry.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    return next();
  } catch (err) {
    return next();
  }
}

// periodic cleanup to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref && setInterval(() => {}, 0);

// Apply rate limiter only to these POST routes
app.post('/api/risk-assess', rateLimitMiddleware, async (req, res) => {
  const body = req.body || {};
  const required = [
    'scenarioId',
    'timeOfDay',
    'userAlone',
    'neighborhoodType',
    'routeLighting',
  ];

  for (const field of required) {
    if (!(field in body)) {
      return res.status(400).json({ error: `missing_${field}` });
    }
  }

  const key = process.env.GEMINI_API_KEY;
  function isPlaceholderKey(k) {
    if (!k) return true;
    const s = String(k).toLowerCase();
    return /your|placeholder|change|replace|xxxx|example/.test(s);
  }

  // helper to respond and optionally persist LOW memories
  function sendResult(obj, model) {
    try {
      if (obj && obj.riskLevel === 'LOW') {
        // Only store non-personal scenario reference and saferAction
        MEMORY.hasMemory = true;
        MEMORY.lastLowScenarioId = body.scenarioId || null;
        MEMORY.lastSaferAction = obj.saferAction || null;
        saveMemory();
      }
    } catch (err) {
      console.error('Failed to update memory:', err && err.message ? err.message : err);
    }
    return res.json({ ...obj, model });
  }

  // If no valid key, return fallback
  if (isPlaceholderKey(key)) {
    const out = fallbackRisk(body);
    return sendResult(out, 'fallback');
  }

  // Try to call Gemini via @google/generative-ai, but fall back on any error
  try {
    let text = null;
    try {
      const { TextGenerationClient } = require('@google/generative-ai');
      const client = new TextGenerationClient({ apiKey: key });

      const prompt = `Given the scenario input: ${JSON.stringify(
        body
      )}\n\nReturn STRICT JSON ONLY (no markdown, no backticks) with keys:\n- riskScore (number 0-100)\n- riskLevel ("LOW"|"MEDIUM"|"HIGH")\n- reasoning (1-2 short sentences)\n- guardianMessage (supportive)\n- saferAction (one actionable)\n\nRespond with only the JSON object.`;

      const response = await client.generate({ model: 'gemini-1.5-flash', input: prompt });
      // attempt common fields used by SDKs
      text = (response?.outputText || response?.text || response?.content || '') + '';
      text = text.trim();
    } catch (err) {
      // SDK failed or not installed -> fallback
      console.error('Gemini SDK call error:', err && err.message ? err.message : err);
      const out = fallbackRisk(body);
      return sendResult(out, 'fallback');
    }

    // Robust parsing: try JSON.parse, else extract first {...}
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // try to extract JSON substring
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first !== -1 && last !== -1 && last > first) {
        try {
          parsed = JSON.parse(text.slice(first, last + 1));
        } catch (e2) {
          parsed = null;
        }
      }
    }

    if (!parsed || !isFinite(Number(parsed.riskScore))) {
      const out = fallbackRisk(body);
      return sendResult(out, 'fallback');
    }

    // Ensure fields types and clamp score
    parsed.riskScore = Math.max(0, Math.min(100, Number(parsed.riskScore)));

    return sendResult(parsed, 'gemini');
  } catch (err) {
    console.error('Unexpected error in /api/risk-assess:', err);
    const out = fallbackRisk(body);
    return sendResult(out, 'fallback');
  }
});

app.post('/api/tts', rateLimitMiddleware, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'missing_text' });
  if (text.length > 400) return res.status(400).json({ error: 'text_too_long' });

  const API_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
  function isPlaceholder(k) {
    if (!k) return true;
    const s = String(k).toLowerCase();
    return /your|placeholder|change|replace|xxxx|example/.test(s);
  }

  if (isPlaceholder(API_KEY) || isPlaceholder(VOICE_ID)) {
    return res.status(500).json({ error: 'elevenlabs_not_configured' });
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok) {
      // try to read returned body to check for payment-related codes
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (e) {
        bodyText = '';
      }

      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch (e) {
        parsed = null;
      }

      // If ElevenLabs indicates payment/plan required or any non-OK, return safe fallback JSON (200)
      if (parsed && (parsed.type === 'payment_required' || parsed.code === 'paid_plan_required')) {
        return res.status(200).json({ ok: false, fallback: true, provider: 'browser_tts', text, reason: 'elevenlabs_unavailable' });
      }

      // For any other non-OK response, also return fallback (do not leak details)
      return res.status(200).json({ ok: false, fallback: true, provider: 'browser_tts', text, reason: 'elevenlabs_unavailable' });
    }

    // Use built-in global fetch and buffer the audio bytes
    const ab = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.send(Buffer.from(ab));
  } catch (err) {
    // Avoid leaking API keys in logs
    const redact = (s) => {
      try {
        if (!s) return s;
        const k = process.env.ELEVENLABS_API_KEY || '';
        return k ? String(s).split(k).join('[REDACTED]') : String(s);
      } catch (_) {
        return '[REDACTED]';
      }
    };
    console.error('ElevenLabs TTS network/error:', redact(err && err.message ? err.message : String(err)));
    // On network errors, return safe fallback JSON (200)
    return res.status(200).json({ ok: false, fallback: true, provider: 'browser_tts', text, reason: 'elevenlabs_unavailable' });
  }
});

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function fallbackRisk(input) {
  let score = 0;
  if (input && input.timeOfDay === 'night') score += 25;
  if (input && input.userAlone === true) score += 25;
  if (input && input.neighborhoodType === 'industrial') score += 20;
  if (input && input.neighborhoodType === 'downtown') score += 10;
  if (input && input.routeLighting === 'poor') score += 20;
  if (input && input.routeLighting === 'mixed') score += 10;

  score = clamp(score, 0, 100);

  let riskLevel = 'LOW';
  if (score >= 70) riskLevel = 'HIGH';
  else if (score >= 40) riskLevel = 'MEDIUM';

  const reasoning = `Score computed from inputs: timeOfDay=${input && input.timeOfDay}, userAlone=${input && input.userAlone}, neighborhoodType=${input && input.neighborhoodType}, routeLighting=${input && input.routeLighting}`;

  const guardianMessage =
    riskLevel === 'HIGH'
      ? 'High risk detected. Stay alert and consider contacting someone you trust.'
      : riskLevel === 'MEDIUM'
      ? 'Moderate risk detected. Stay aware of your surroundings.'
      : 'Low risk detected. Exercise normal caution.';

  const saferAction =
    riskLevel === 'HIGH'
      ? 'Avoid the route if possible, choose a well-lit path, or ask someone to accompany you.'
      : riskLevel === 'MEDIUM'
      ? 'Prefer well-lit routes and stay in populated areas.'
      : 'Proceed but remain aware of surroundings.';

  return {
    riskScore: score,
    riskLevel,
    reasoning,
    guardianMessage,
    saferAction,
  };
}

module.exports.fallbackRisk = fallbackRisk;

const port = process.env.PORT || 8080;

// Ensure these routes are registered before any 404 handler
app.get('/', (req, res) =>
  res.json({
    ok: true,
    name: 'SafeCircle Backend',
    message: 'Backend is running. Visit /health or /api/docs',
    links: {
      health: '/health',
      docs: '/api/docs',
      scenarios: '/api/scenarios',
      risk: '/api/risk-assess',
      memory: '/api/memory-echo',
      ttsInfo: '/api/tts',
    },
  })
);
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/docs', (req, res) => res.json({ ok: true, note: 'docs endpoint is live' }));

// 404 catch-all - placed after all routes
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Basic error handler (must be after routes & 404)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

module.exports = app;
