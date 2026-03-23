import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_IMAGE_API_KEY = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_IMAGE_MODE = (process.env.GEMINI_IMAGE_MODE || "live").toLowerCase();
const GEMINI_IMAGE_SIZE = process.env.GEMINI_IMAGE_SIZE || "1024x1536";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const HOST = process.env.HOST || "127.0.0.1";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      const textProvider = getTextProvider();
      const useLiveText = Boolean(textProvider);
      const imageProvider = getImageProvider();
      const useLiveImages = Boolean(imageProvider);

      return sendJson(res, 200, {
        ok: true,
        textMode: useLiveText ? "live" : "demo",
        textProvider: textProvider || "fallback",
        imageMode: useLiveImages ? "live" : "poster",
        imageProvider: imageProvider || "poster",
        warning: useLiveText
          ? null
          : "No Gemini or OpenAI key is configured. The app is using the local fallback generator until `.env` is set."
      });
    }

    if (req.method === "POST" && url.pathname === "/api/storyboard") {
      const body = await readJson(req);
      const prompt = `${body?.prompt || ""}`.trim();

      if (!prompt) {
        return sendJson(res, 400, { error: "A one-line story prompt is required." });
      }

      const storyboard = await buildStoryboard(prompt);
      return sendJson(res, 200, storyboard);
    }

    if (req.method === "GET") {
      return await serveStatic(url.pathname, res);
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    const status = error?.statusCode || 500;
    const message = error?.publicMessage || "Something went wrong while directing the storyboard.";
    sendJson(res, status, { error: message });
  }
});

if (isMainModule()) {
  server.listen(PORT, HOST, () => {
    console.log(`Auto-Director is running at http://${HOST}:${PORT}`);
  });
}

export async function buildStoryboard(seedPrompt) {
  const textProvider = getTextProvider();
  const useLiveText = Boolean(textProvider);
  const imageProvider = getImageProvider();
  const useLiveImages = Boolean(imageProvider);
  const demoWarning = useLiveText
    ? null
    : "No Gemini or OpenAI key is configured. You are seeing the local fallback, not live AI-generated story output.";

  try {
    const outline = useLiveText
      ? await generateOutline(seedPrompt, textProvider)
      : generateDemoOutline(seedPrompt);

    const storyboard = useLiveText
      ? await generateShotPlan(seedPrompt, outline, textProvider)
      : generateDemoShotPlan(seedPrompt, outline);

    const visualResult = await renderShotVisuals({
      seedPrompt,
      storyTitle: storyboard.title || outline.title,
      acts: storyboard.acts,
      useLiveImages
    });
    const liveImagesWorked = useLiveImages && visualResult.liveImageSuccessCount > 0;
    const warningParts = [demoWarning];

    if (useLiveImages && !liveImagesWorked && visualResult.firstImageError) {
      warningParts.push(`${labelProvider(imageProvider)} image request failed: ${visualResult.firstImageError} Using poster visuals instead.`);
    }

    return {
      ok: true,
      prompt: seedPrompt,
      mode: {
        text: useLiveText ? "live" : "demo",
        textProvider: textProvider || "fallback",
        images: liveImagesWorked ? "live" : "poster",
        imageProvider: liveImagesWorked ? imageProvider || "poster" : "poster"
      },
      story: {
        title: storyboard.title || outline.title,
        genre: outline.genre,
        tone: outline.tone,
        logline: outline.logline,
        themes: outline.themes,
        hook: outline.hook,
        acts: visualResult.acts
      },
      warning: warningParts.filter(Boolean).join(" ") || null
    };
  } catch (error) {
    console.error("Falling back to demo pipeline:", error);
    const reason =
      error?.publicMessage || "Live AI generation failed for an unknown reason.";

    const outline = generateDemoOutline(seedPrompt);
    const storyboard = generateDemoShotPlan(seedPrompt, outline);
    const visualResult = await renderShotVisuals({
      seedPrompt,
      storyTitle: outline.title,
      acts: storyboard.acts,
      useLiveImages: false
    });

    return {
      ok: true,
      prompt: seedPrompt,
      mode: {
        text: "demo",
        textProvider: textProvider || "fallback",
        images: "poster",
        imageProvider: "poster"
      },
      story: {
        title: outline.title,
        genre: outline.genre,
        tone: outline.tone,
        logline: outline.logline,
        themes: outline.themes,
        hook: outline.hook,
        acts: visualResult.acts
      },
      warning: `${labelProvider(textProvider)} request failed: ${reason} The app switched to local fallback mode.`
    };
  }
}

async function generateOutline(seedPrompt, provider) {
  const system = [
    "You are Agent 1: the screenwriter for a cinematic storyboard generator.",
    "Return only valid JSON that matches the schema.",
    "Write visually rich but concise output.",
    "The story must be coherent, filmable, and suitable for a 3-act storyboard."
  ].join(" ");

  const user = [
    `Seed prompt: ${seedPrompt}`,
    "Create a 3-act outline with exactly 3 scenes per act.",
    "Each scene should feel distinct, escalate naturally, and be easy for a cinematographer to visualize."
  ].join("\n");

  return createStructuredTextCompletion({
    provider,
    system,
    user,
    schemaName: "screenwriter_outline",
    schema: provider === "gemini" ? outlineSchemaGemini : outlineSchema
  });
}

async function generateShotPlan(seedPrompt, outline, provider) {
  if (provider === "gemini") {
    return generateDemoShotPlan(seedPrompt, outline);
  }

  const system = [
    "You are Agent 2: the cinematographer for a cinematic storyboard generator.",
    "Return only valid JSON that matches the schema.",
    "Expand the provided outline into a shot plan with exactly 3 shots per scene.",
    "Every shot must be visually precise and production-friendly.",
    "Every image_prompt must be ready for an image generator, grounded in the scene, and avoid brand names."
  ].join(" ");

  const user = [
    `Seed prompt: ${seedPrompt}`,
    "Outline JSON:",
    JSON.stringify(outline),
    "Produce the final storyboard shot plan now."
  ].join("\n");

  return createStructuredTextCompletion({
    provider,
    system,
    user,
    schemaName: "cinematographer_storyboard",
    schema: storyboardSchema
  });
}

async function createStructuredTextCompletion({ provider, system, user, schemaName, schema }) {
  if (provider === "gemini") {
    return createStructuredGeminiCompletion({ system, user, schemaName });
  }

  if (provider === "openai") {
    return createStructuredOpenAICompletion({ system, user, schemaName, schema });
  }

  throw new ApiError(500, "No live AI provider is configured.");
}

async function createStructuredGeminiCompletion({ system, user, schemaName }) {
  const contract = buildGeminiJsonContract(schemaName);
  const response = await fetch(
    `${GEMINI_BASE_URL}/${encodeURIComponent(GEMINI_TEXT_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: `${system}\n\nReturn JSON only. Do not use markdown fences. Use strict JSON with double quotes, no trailing commas, and no commentary outside the JSON object.`
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `${user}\n\nJSON contract:\n${contract}` }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      })
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message || "Gemini text generation failed.");
  }

  const content = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();

  if (!content) {
    const blockReason = payload?.promptFeedback?.blockReason;
    throw new ApiError(502, blockReason ? `Gemini blocked the prompt: ${blockReason}.` : "Gemini returned an empty response.");
  }

  try {
    return parseLenientJson(content);
  } catch (error) {
    throw new ApiError(502, error?.message || "Gemini returned malformed JSON.");
  }
}

async function createStructuredOpenAICompletion({ system, user, schemaName, schema }) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      temperature: 0.9,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema
        }
      }
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message || "OpenAI text generation failed.");
  }

  const content = payload?.choices?.[0]?.message?.content;

  if (!content) {
    throw new ApiError(502, "The model returned an empty response.");
  }

  return JSON.parse(content);
}

function getTextProvider() {
  if (GEMINI_API_KEY) {
    return "gemini";
  }

  if (OPENAI_API_KEY) {
    return "openai";
  }

  return null;
}

function getImageProvider() {
  if (GEMINI_IMAGE_API_KEY && GEMINI_IMAGE_MODE === "live") {
    return "gemini";
  }

  return null;
}

function labelProvider(provider) {
  if (provider === "gemini") {
    return "Gemini";
  }

  if (provider === "openai") {
    return "OpenAI";
  }

  if (provider === "gemini") {
    return "Gemini";
  }

  return "Live AI";
}

function buildGeminiJsonContract(schemaName) {
  if (schemaName === "screenwriter_outline") {
    return `{
  "title": "string",
  "genre": "string",
  "tone": "string",
  "logline": "string",
  "hook": "string",
  "themes": ["string", "string", "string"],
  "acts": [
    {
      "actNumber": 1,
      "title": "string",
      "summary": "string",
      "emotionalBeat": "string",
      "scenes": [
        {
          "sceneNumber": 1,
          "title": "string",
          "summary": "string",
          "location": "string",
          "timeOfDay": "string"
        }
      ]
    }
  ]
}
Rules:
- exactly 3 acts
- exactly 3 scenes per act
- keep all fields present
- use compact, vivid prose`;
  }

  return `Return a valid JSON object for ${schemaName}.`;
}

function parseLenientJson(raw) {
  const candidates = [];
  const trimmed = `${raw}`.trim();
  const unwrapped = trimmed.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  const braceStart = unwrapped.indexOf("{");
  const braceEnd = unwrapped.lastIndexOf("}");
  const extracted =
    braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart
      ? unwrapped.slice(braceStart, braceEnd + 1)
      : unwrapped;

  candidates.push(unwrapped, extracted);
  candidates.push(extracted.replace(/,\s*([}\]])/g, "$1"));
  candidates.push(
    extracted
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
  );

  let lastError = null;

  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Malformed JSON.");
}

async function renderShotVisuals({ seedPrompt, storyTitle, acts, useLiveImages }) {
  const rendered = [];
  let liveImageSuccessCount = 0;
  let firstImageError = null;

  for (let actIndex = 0; actIndex < acts.length; actIndex += 1) {
    const act = acts[actIndex];
    const scenes = [];

    for (let sceneIndex = 0; sceneIndex < act.scenes.length; sceneIndex += 1) {
      const scene = act.scenes[sceneIndex];
      const shots = [];

      for (let shotIndex = 0; shotIndex < scene.shots.length; shotIndex += 1) {
        const shot = scene.shots[shotIndex];
        let visual = null;

        if (useLiveImages && !firstImageError) {
          try {
            visual = await generateLiveImage({
              seedPrompt,
              act,
              scene,
              shot
            });
            liveImageSuccessCount += 1;
          } catch (error) {
            firstImageError =
              error?.publicMessage || error?.message || "Live image generation failed.";
          }
        }

        shots.push({
          ...shot,
          visual: visual || {
            type: "poster",
            src: buildPosterDataUrl({
              storyTitle,
              sceneTitle: scene.title,
              shot,
              palette: scene.palette,
              actNumber: act.actNumber,
              sceneNumber: scene.sceneNumber
            }),
            alt: `${shot.framing} poster frame for ${scene.title}`
          }
        });
      }

      scenes.push({
        ...scene,
        shots
      });
    }

    rendered.push({
      ...act,
      scenes
    });
  }

  return {
    acts: rendered,
    liveImageSuccessCount,
    firstImageError
  };
}

async function generateLiveImage({ seedPrompt, act, scene, shot }) {
  const imageProvider = getImageProvider();

  if (imageProvider === "gemini") {
    return generateGeminiImage({ seedPrompt, act, scene, shot });
  }

  throw new ApiError(500, "No live image provider is configured.");
}

async function generateGeminiImage({ seedPrompt, act, scene, shot }) {
  const prompt = [
    `Story seed: ${seedPrompt}.`,
    `Act ${act.actNumber}: ${act.title}.`,
    `Scene ${scene.sceneNumber}: ${scene.title}.`,
    `Shot ${shot.shotNumber}: ${shot.title}.`,
    `Framing: ${shot.framing}.`,
    `Angle: ${shot.angle}.`,
    `Movement: ${shot.movement}.`,
    `Lighting: ${shot.lighting}.`,
    `Palette: ${scene.palette}.`,
    shot.imagePrompt,
    "High-detail cinematic still, strong composition, visually readable subject, no text or watermark."
  ].join(" ");

  const response = await fetch(`${GEMINI_OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GEMINI_IMAGE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GEMINI_IMAGE_MODEL,
      prompt,
      response_format: "b64_json",
      n: 1,
      size: GEMINI_IMAGE_SIZE
    })
  });

  if (!response.ok) {
    let message = "Gemini image generation failed.";

    try {
      const payload = await response.json();
      message =
        payload?.message ||
        payload?.error?.message ||
        payload?.errors?.join?.("; ") ||
        message;
    } catch {
      message = `${message} HTTP ${response.status}.`;
    }

    throw new ApiError(response.status, message);
  }

  const payload = await response.json();
  const base64 = payload?.data?.[0]?.b64_json;

  if (!base64) {
    throw new ApiError(502, "Gemini image generation returned no image.");
  }

  return {
    type: "image",
    src: `data:image/png;base64,${base64}`,
    alt: `${shot.framing} image for ${scene.title}`
  };
}

function generateDemoOutline(seedPrompt) {
  const flavor = deriveFlavor(seedPrompt);

  return {
    title: flavor.title,
    genre: flavor.genre,
    tone: flavor.tone,
    logline: flavor.logline || `${flavor.hero} faces ${flavor.conflict} and must ${flavor.goal} before ${flavor.clock}.`,
    hook: flavor.hook,
    themes: flavor.themes,
    acts: [
      {
        actNumber: 1,
        title: "The Setup",
        summary: flavor.actSummaries?.[0] || `${flavor.hero} enters a world shaped by ${flavor.worldTexture}. A fragile plan begins to form.`,
        emotionalBeat: flavor.emotionalBeats?.[0] || "Curiosity sharpened by pressure",
        scenes: [
          {
            sceneNumber: 1,
            title: flavor.sceneTitles[0],
            summary: flavor.sceneSummaries?.[0] || `${flavor.hero} surveys the opportunity and tests the first boundary.`,
            location: flavor.locations[0],
            timeOfDay: "Night"
          },
          {
            sceneNumber: 2,
            title: flavor.sceneTitles[1],
            summary: flavor.sceneSummaries?.[1] || `The team gains a clue, but the system guarding the objective reveals unexpected intelligence.`,
            location: flavor.locations[1],
            timeOfDay: "Late night"
          },
          {
            sceneNumber: 3,
            title: flavor.sceneTitles[2],
            summary: flavor.sceneSummaries?.[2] || `A false success opens the door to a much bigger risk.`,
            location: flavor.locations[2],
            timeOfDay: "Before dawn"
          }
        ]
      },
      {
        actNumber: 2,
        title: "The Collision",
        summary: flavor.actSummaries?.[1] || `${flavor.hero} pushes deeper, and every gain comes with a cost.`,
        emotionalBeat: flavor.emotionalBeats?.[1] || "Momentum turning volatile",
        scenes: [
          {
            sceneNumber: 1,
            title: flavor.sceneTitles[3],
            summary: flavor.sceneSummaries?.[3] || `A hidden countermeasure traps the characters inside a tightening maze of choices.`,
            location: flavor.locations[3],
            timeOfDay: "Predawn"
          },
          {
            sceneNumber: 2,
            title: flavor.sceneTitles[4],
            summary: flavor.sceneSummaries?.[4] || `${flavor.hero} confronts an internal fracture while the mission unravels in public view.`,
            location: flavor.locations[4],
            timeOfDay: "Blue hour"
          },
          {
            sceneNumber: 3,
            title: flavor.sceneTitles[5],
            summary: flavor.sceneSummaries?.[5] || `The midpoint failure forces a reckless reinvention of the plan.`,
            location: flavor.locations[5],
            timeOfDay: "Sunrise"
          }
        ]
      },
      {
        actNumber: 3,
        title: "The Resolution",
        summary: flavor.actSummaries?.[2] || `The final move converts instinct into strategy, and the story pays off its emotional promise.`,
        emotionalBeat: flavor.emotionalBeats?.[2] || "Release through decisive action",
        scenes: [
          {
            sceneNumber: 1,
            title: flavor.sceneTitles[6],
            summary: flavor.sceneSummaries?.[6] || `${flavor.hero} commits to the version of the plan nobody believed could work.`,
            location: flavor.locations[6],
            timeOfDay: "Morning glow"
          },
          {
            sceneNumber: 2,
            title: flavor.sceneTitles[7],
            summary: flavor.sceneSummaries?.[7] || `The central confrontation turns spectacle into character revelation.`,
            location: flavor.locations[7],
            timeOfDay: "Morning"
          },
          {
            sceneNumber: 3,
            title: flavor.sceneTitles[8],
            summary: flavor.sceneSummaries?.[8] || `Aftermath reframes the mission and hints at the cost of winning.`,
            location: flavor.locations[8],
            timeOfDay: "After sunrise"
          }
        ]
      }
    ]
  };
}

function generateDemoShotPlan(seedPrompt, outline) {
  const acts = outline.acts.map((act) => ({
    actNumber: act.actNumber,
    title: act.title,
    summary: act.summary,
    emotionalBeat: act.emotionalBeat,
    scenes: act.scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      summary: scene.summary,
      location: scene.location,
      timeOfDay: scene.timeOfDay,
      palette: buildPalette(act.actNumber, scene.sceneNumber),
      shots: buildShots(seedPrompt, act, scene)
    }))
  }));

  return {
    title: outline.title,
    acts
  };
}

function buildShots(seedPrompt, act, scene) {
  const templates = [
    {
      title: "World Lock-In",
      framing: "Wide Shot",
      angle: "Low angle",
      movement: "Slow push-in",
      lighting: "Atmospheric practicals",
      description: `Establish ${scene.location} as a charged space where ${scene.summary.toLowerCase()}.`,
      imagePrompt: `Cinematic wide shot, ${scene.location}, ${scene.timeOfDay}, dramatic environment, story seed "${seedPrompt}", moody depth, highly legible composition.`
    },
    {
      title: "Pressure Detail",
      framing: "Close-up",
      angle: "Eye level",
      movement: "Locked-off tension",
      lighting: "Directional highlight",
      description: `Focus on the decisive detail that reveals what the characters stand to lose.`,
      imagePrompt: `Cinematic close-up, tactile detail, subtle emotion, ${scene.location}, ${scene.timeOfDay}, dramatic contrast, grounded realism, story seed "${seedPrompt}".`
    },
    {
      title: "Choice in Motion",
      framing: "Over-the-shoulder",
      angle: "Dutch tilt accent",
      movement: "Tracking move",
      lighting: "Edge-lit silhouette",
      description: `Capture the turning point where intention becomes action and the scene tilts into the next beat.`,
      imagePrompt: `Over-the-shoulder cinematic shot, dynamic movement, ${scene.location}, ${scene.timeOfDay}, high-stakes action beat, visual storytelling, story seed "${seedPrompt}".`
    }
  ];

  return templates.map((template, index) => ({
    shotNumber: index + 1,
    ...template
  }));
}

function deriveFlavor(seedPrompt) {
  const lower = seedPrompt.toLowerCase();

  const presets = [
    {
      match: ["rewind", "seconds", "device", "mechanic", "machine", "clockwork"],
      title: "Ten Seconds Back",
      genre: "Grounded sci-fi thriller",
      tone: "Tense, clever, and intimate",
      hero: "a small-town mechanic",
      conflict: "a powerful hunter who sees the rewind device as a weapon",
      goal: "keep the device out of the wrong hands and learn how to beat an enemy with only ten seconds of leverage",
      clock: "the secret spreads beyond the town",
      logline: "A small-town mechanic accidentally repairs a device that rewinds ten seconds, then has to outthink a powerful enemy who wants to control it.",
      hook: "Ten seconds is not enough to fix a life, but it is enough to survive one fatal mistake.",
      themes: ["power and responsibility", "ingenuity under pressure", "small choices with huge consequences"],
      worldTexture: "grease-stained garages, deserted back roads, and split-second second chances",
      emotionalBeats: [
        "Wonder sharpened by danger",
        "Paranoia turning tactical",
        "Resolve through sacrifice"
      ],
      actSummaries: [
        "A small-town mechanic accidentally revives a broken device that can rewind ten seconds and realizes the impossible machine could change everything.",
        "When a powerful figure comes hunting for the device, the mechanic survives by using tiny rewinds to dodge traps, test choices, and stay one move ahead.",
        "Forced into a final confrontation, the mechanic turns the device's brutal limit into an advantage and decides whether the invention should survive at all."
      ],
      sceneTitles: [
        "The Broken Thing Works",
        "Ten Seconds of Wonder",
        "Someone Else Notices",
        "The First Chase",
        "Learning the Limit",
        "A Town With No Hiding Place",
        "Building the Countermove",
        "The Last Rewind",
        "What Time Leaves Behind"
      ],
      sceneSummaries: [
        "In a cluttered garage, a routine repair accidentally wakes the device and reveals its ten-second rewind.",
        "The mechanic tests the machine in secret, turning small accidents into eerie proof that time can be bent.",
        "A powerful outsider catches a hint of the device and begins closing in on the town.",
        "The first direct threat forces the mechanic to use the rewind in panic and discover how little ten seconds really is.",
        "Experimenting under pressure, the mechanic learns the device can save a moment but cannot erase the cost of using it.",
        "The chase spills into familiar streets, making the whole town feel like enemy territory.",
        "With nowhere left to run, the mechanic builds a plan around prediction, timing, and one narrow opening.",
        "The final showdown becomes a battle of timing where ten seconds decides everything.",
        "In the aftermath, the mechanic chooses what kind of future deserves to exist."
      ],
      locations: [
        "a cluttered roadside garage",
        "an empty gas station lot",
        "a diner parking lot at closing time",
        "a rain-slick main street",
        "a workshop lit by oscillating fluorescents",
        "the quiet grid of a small town at dawn",
        "a salvage yard maze",
        "an abandoned factory floor",
        "a garage at first light"
      ]
    },
    {
      match: ["lie", "lies", "reality", "true", "girl"],
      title: "The Weight of a Lie",
      genre: "Surreal fantasy thriller",
      tone: "Uncanny, escalating, and emotionally sharp",
      hero: "a girl whose smallest lie can rewrite the world",
      conflict: "a reality that keeps obeying the wrong version of the truth",
      goal: "stop her own lies from remaking the people and world around her",
      clock: "the rewritten reality hardens for good",
      logline: "A girl discovers that every lie she tells subtly rewrites reality to make it true, until the world becomes a trap built from her own words.",
      hook: "At first the lies make life easier. Then they start deciding what reality is allowed to be.",
      themes: ["truth versus comfort", "identity under pressure", "the cost of self-protection"],
      worldTexture: "ordinary rooms turning uncanny, memories slipping sideways, and truth losing its shape",
      emotionalBeats: [
        "Temptation wrapped in disbelief",
        "Control slipping into panic",
        "Honesty as the only escape"
      ],
      actSummaries: [
        "A girl realizes that every lie she tells quietly rewrites reality to make the lie true, turning everyday deception into a thrilling private power.",
        "As the lies get bigger, the rewritten world grows stranger, relationships warp around false memories, and she starts losing track of what used to be real.",
        "With reality spiraling out of control, she has to tell the hardest truth of her life and face what disappears when the lies stop holding the world together."
      ],
      sceneTitles: [
        "The First Lie Lands",
        "Tiny Miracles",
        "A Better Version of Yesterday",
        "The World Starts Bending",
        "Memories That Never Happened",
        "The Lie That Goes Too Far",
        "Hunting the Original Truth",
        "Speaking the One Thing She Avoided",
        "The World After Honesty"
      ],
      sceneSummaries: [
        "A harmless lie unexpectedly comes true, and the girl notices reality has shifted just enough to feel wrong.",
        "She experiments with small falsehoods and watches life rearrange itself in ways that feel magical and dangerous.",
        "The rewritten world starts rewarding lies, making truth feel clumsy and expensive.",
        "As the changes spread, rooms, routines, and relationships begin mutating around her words.",
        "People she loves remember events that never happened, and the original past starts slipping away.",
        "One desperate lie solves a problem and creates a much worse reality in its place.",
        "She digs for proof of the world as it was, hoping something real still exists beneath the rewrites.",
        "The climax forces her to speak an unbearable truth that the new reality cannot comfortably survive.",
        "What remains is quieter, more honest, and permanently marked by what her lies almost became."
      ],
      locations: [
        "a familiar bedroom that feels subtly altered",
        "a school hallway with uncanny stillness",
        "a kitchen full of wrong details",
        "a city street rewritten by rumor",
        "a classroom shaped by false memory",
        "a party where truth keeps slipping",
        "a notebook filled with crossed-out realities",
        "a rooftop at stormlight",
        "the morning world after the reset"
      ]
    },
    {
      match: ["heist", "vault", "robbery"],
      title: "Midnight Access",
      genre: "Sci-fi thriller",
      tone: "Sleek, tense, and propulsive",
      hero: "a precision thief with a disappearing window",
      conflict: "an adaptive security network that learns every move",
      goal: "steal the truth buried inside the vault",
      clock: "the building seals itself forever at dawn",
      hook: "The vault is easiest to crack only after it realizes someone is inside.",
      themes: ["trust under pressure", "technology versus instinct", "the cost of perfection"],
      worldTexture: "mirrored steel, scanning beams, and impossible quiet",
      locations: [
        "the skyline approach",
        "a service corridor lined with red sensors",
        "the iris gate to the vault chamber",
        "a suspended glass catwalk",
        "the control room aquarium",
        "the collapsing archive shaft",
        "the hidden maintenance spine",
        "the core vault platform",
        "the city roof at sunrise"
      ],
      sceneTitles: [
        "The Silent Approach",
        "Ghosts in the Corridor",
        "A Door That Watches Back",
        "The Catwalk Trap",
        "The Fracture in the Crew",
        "The Plan Burns Down",
        "The Impossible Route",
        "Inside the Core",
        "What Was Worth Taking"
      ]
    },
    {
      match: ["space", "planet", "alien", "moon"],
      title: "Echoes Above Titan",
      genre: "Space adventure",
      tone: "Awe-filled, tense, and human",
      hero: "a pilot chasing a voice from the dead",
      conflict: "a storm-wrapped frontier that keeps rewriting the mission",
      goal: "recover the signal source and learn why it answered back",
      clock: "their ship loses orbit in less than an hour",
      hook: "The planet does not speak in words, but it answers anyway.",
      themes: ["memory and legacy", "wonder versus fear", "survival through trust"],
      worldTexture: "frozen haze, fractured light, and vast engineered ruins",
      locations: [
        "the descent window",
        "a frostbitten landing field",
        "the echoing relay trench",
        "a bridge over methane fog",
        "the cracked observatory",
        "a storm-battered rover line",
        "the buried access ring",
        "the signal cathedral",
        "orbit at daybreak"
      ],
      sceneTitles: [
        "Descent Through Static",
        "Landing in Blue Ice",
        "The Relay Wakes",
        "A Bridge Over the Void",
        "Old Messages, New Wounds",
        "The Storm Changes Course",
        "Down Through the Ring",
        "The Cathedral Listens",
        "Orbit With an Answer"
      ]
    }
  ];

  const preset = presets.find((item) => item.match.some((term) => lower.includes(term))) || buildGenericFlavor(seedPrompt);

  return preset;
}

function buildGenericFlavor(seedPrompt) {
  const clean = normalizePrompt(seedPrompt);
  const protagonist = extractProtagonist(clean);
  const [leadClause, turnClause] = splitPrompt(clean);
  const genre = inferGenre(clean);
  const tone = inferTone(clean);
  const title = buildFallbackTitle(clean);
  const themes = inferThemes(clean);
  const worldTexture = inferWorldTexture(clean);
  const consequence = turnClause || "the consequences start multiplying faster than the protagonist can control";
  const goal = inferGoal(clean, protagonist);

  return {
    title,
    genre,
    tone,
    hero: protagonist,
    conflict: lowerFirst(consequence),
    goal,
    clock: "the situation becomes impossible to contain",
    logline: `${capitalize(protagonist)} is pulled into chaos when ${lowerFirst(leadClause)}, and must survive as ${lowerFirst(consequence)}.`,
    hook: `What begins as ${lowerFirst(leadClause)} turns into a crisis that keeps rewriting the rules around ${protagonist}.`,
    themes,
    worldTexture,
    emotionalBeats: [
      "Discovery under pressure",
      "Escalation without control",
      "A final choice with consequences"
    ],
    actSummaries: [
      `${capitalize(protagonist)} is thrown off balance when ${lowerFirst(leadClause)}, opening the door to a world shaped by ${worldTexture}.`,
      `The danger escalates as ${lowerFirst(consequence)}, forcing ${protagonist} to improvise with less certainty and higher stakes.`,
      `${capitalize(protagonist)} reaches a final confrontation that turns the story's core idea into the only possible way forward.`
    ],
    sceneTitles: [
      "The First Shift",
      "Testing the Edge",
      "The Problem Gets Noticed",
      "Escalation",
      "The Cost Reveals Itself",
      "No Easy Way Out",
      "A Desperate Plan",
      "The Core Confrontation",
      "After the Change"
    ],
    sceneSummaries: [
      `${capitalize(protagonist)} experiences the first undeniable sign that life has changed.`,
      `Curiosity turns active as the new possibility is tested in secret.`,
      `The situation stops being private and starts attracting pressure.`,
      `A direct threat transforms the idea into a real problem.`,
      `The cost of the central idea becomes impossible to ignore.`,
      `Trying to outrun the consequences only deepens them.`,
      `${capitalize(protagonist)} builds one last plan from incomplete information.`,
      `The climax forces action instead of theory.`,
      `The ending reveals what the story changed permanently.`
    ],
    locations: [
      "the place where everything first goes wrong",
      "a private corner for dangerous experiments",
      "a public space where tension becomes visible",
      "a route with no safe exits",
      "a room full of consequences",
      "the edge of collapse",
      "a hidden place to prepare",
      "the center of the conflict",
      "the quiet place after impact"
    ]
  };
}

function normalizePrompt(value) {
  return `${value}`.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
}

function splitPrompt(prompt) {
  const markers = [" but ", " until ", " before ", " after ", " while ", " as ", " because "];

  for (const marker of markers) {
    const index = prompt.toLowerCase().indexOf(marker);

    if (index > 0) {
      return [prompt.slice(0, index).trim(), prompt.slice(index + marker.length).trim()];
    }
  }

  return [prompt, ""];
}

function extractProtagonist(prompt) {
  const everyTimeMatch = prompt.match(/^Every time (an? [^,]+?|the [^,]+?)\s+[a-z]+/i);
  if (everyTimeMatch?.[1]) {
    return everyTimeMatch[1].toLowerCase();
  }

  const actionMatch = prompt.match(/^(an? [^,]+?|the [^,]+?)\s+(accidentally|discovers?|finds?|realizes?|fixes?|builds?|opens?|steals?|wakes?|uses?|hears?|sees?|learns?|lies)\b/i);
  if (actionMatch?.[1]) {
    return actionMatch[1].toLowerCase();
  }

  return "an unlikely protagonist";
}

function inferGenre(prompt) {
  const lower = prompt.toLowerCase();

  if (/\b(ghost|haunted|monster|curse|demon)\b/.test(lower)) {
    return "Supernatural thriller";
  }

  if (/\b(rewind|time|future|device|robot|machine|portal)\b/.test(lower)) {
    return "Speculative thriller";
  }

  if (/\b(lie|reality|memory|dream|wish)\b/.test(lower)) {
    return "Surreal fantasy drama";
  }

  return "Cinematic speculative drama";
}

function inferTone(prompt) {
  const lower = prompt.toLowerCase();

  if (/\b(powerful|wants it|chase|hunt|danger|spiral)\b/.test(lower)) {
    return "Urgent, tense, and cinematic";
  }

  if (/\b(lie|reality|memory|dream)\b/.test(lower)) {
    return "Uncanny, emotional, and escalating";
  }

  return "Bold, emotional, and visually rich";
}

function inferThemes(prompt) {
  const lower = prompt.toLowerCase();

  if (/\b(rewind|time|seconds)\b/.test(lower)) {
    return ["consequences", "control", "sacrifice"];
  }

  if (/\b(lie|lies|truth|reality)\b/.test(lower)) {
    return ["truth versus comfort", "identity", "responsibility"];
  }

  return ["choice under pressure", "identity", "consequences"];
}

function inferWorldTexture(prompt) {
  const lower = prompt.toLowerCase();

  if (/\bsmall-town|mechanic|garage\b/.test(lower)) {
    return "oil stains, local roads, and danger arriving in familiar places";
  }

  if (/\b(lie|reality|memory)\b/.test(lower)) {
    return "ordinary spaces turning uncanny and memory sliding out of place";
  }

  return "sudden danger, unstable rules, and a world that stops feeling ordinary";
}

function inferGoal(prompt, protagonist) {
  const lower = prompt.toLowerCase();

  if (/\b(rewind|time|device)\b/.test(lower)) {
    return "keep the discovery from being weaponized and survive long enough to control it";
  }

  if (/\b(lie|lies|reality|truth)\b/.test(lower)) {
    return "restore what is true before the damage becomes permanent";
  }

  return `${protagonist} must understand the new danger before it takes over everything`;
}

function buildFallbackTitle(prompt) {
  const words = prompt
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !stopWords.has(word.toLowerCase()))
    .slice(0, 3);

  if (!words.length) {
    return "Untitled Story";
  }

  return words.map((word) => capitalize(word.toLowerCase())).join(" ");
}

function lowerFirst(value) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function buildPalette(actNumber, sceneNumber) {
  const palettes = [
    ["ember red", "brushed silver", "midnight navy"],
    ["electric cyan", "amber gold", "carbon black"],
    ["sunrise peach", "cold steel", "ghost white"]
  ];

  return palettes[(actNumber + sceneNumber - 2) % palettes.length].join(", ");
}

function buildPosterDataUrl({ storyTitle, sceneTitle, shot, palette, actNumber, sceneNumber }) {
  const gradients = [
    ["#1e293b", "#d97706", "#fbbf24"],
    ["#0f172a", "#0891b2", "#67e8f9"],
    ["#1f2937", "#9a3412", "#fb7185"]
  ];
  const colors = gradients[(actNumber + sceneNumber - 2) % gradients.length];
  const safe = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1400" viewBox="0 0 900 1400">
      <defs>
        <linearGradient id="wash" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${colors[0]}"/>
          <stop offset="50%" stop-color="${colors[1]}"/>
          <stop offset="100%" stop-color="${colors[2]}"/>
        </linearGradient>
        <radialGradient id="bloom" cx="75%" cy="18%" r="65%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.50)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>
      <rect width="900" height="1400" fill="url(#wash)"/>
      <circle cx="700" cy="280" r="320" fill="url(#bloom)"/>
      <path d="M0 1080 C180 960 320 1180 470 1040 C620 900 760 920 900 820 L900 1400 L0 1400 Z" fill="rgba(15,23,42,0.45)"/>
      <rect x="58" y="58" width="784" height="1284" rx="36" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
      <text x="72" y="110" fill="rgba(255,255,255,0.75)" font-family="'Avenir Next', 'Trebuchet MS', sans-serif" font-size="30" letter-spacing="6">AUTO-DIRECTOR</text>
      <text x="72" y="188" fill="#fff7ed" font-family="'Iowan Old Style', 'Palatino Linotype', serif" font-size="74" font-weight="700">${safe(storyTitle)}</text>
      <text x="72" y="252" fill="rgba(255,255,255,0.88)" font-family="'Avenir Next', 'Trebuchet MS', sans-serif" font-size="32">${safe(`Act ${actNumber} / Scene ${sceneNumber}`)}</text>
      <text x="72" y="310" fill="rgba(255,255,255,0.92)" font-family="'Iowan Old Style', 'Palatino Linotype', serif" font-size="52">${safe(sceneTitle)}</text>
      <text x="72" y="1035" fill="#fff" font-family="'Avenir Next', 'Trebuchet MS', sans-serif" font-size="28" letter-spacing="4">${safe(shot.framing.toUpperCase())}</text>
      <text x="72" y="1110" fill="#fff7ed" font-family="'Iowan Old Style', 'Palatino Linotype', serif" font-size="64">${safe(shot.title)}</text>
      <text x="72" y="1172" fill="rgba(255,255,255,0.80)" font-family="'Avenir Next', 'Trebuchet MS', sans-serif" font-size="26">${safe(`${shot.angle} / ${shot.movement}`)}</text>
      <foreignObject x="72" y="1205" width="756" height="110">
        <div xmlns="http://www.w3.org/1999/xhtml" style="color: rgba(255,255,255,0.86); font-family: 'Avenir Next', 'Trebuchet MS', sans-serif; font-size: 24px; line-height: 1.45;">
          ${safe(shot.description)}
        </div>
      </foreignObject>
      <text x="72" y="1340" fill="rgba(255,255,255,0.70)" font-family="'Avenir Next', 'Trebuchet MS', sans-serif" font-size="22">${safe(`Palette: ${palette}`)}</text>
    </svg>
  `.replace(/\n\s+/g, "");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1_000_000) {
        reject(new ApiError(413, "Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, "Invalid JSON payload."));
      }
    });

    req.on("error", (error) => reject(error));
  });
}

async function serveStatic(pathname, res) {
  let requestPath = pathname === "/" ? "/index.html" : pathname;
  requestPath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");

  const filePath = join(publicDir, requestPath);
  if (!filePath.startsWith(publicDir)) {
    throw new ApiError(403, "Forbidden.");
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ApiError(404, "Not found.");
    }

    throw error;
  }

  const type = mimeTypes[extname(filePath)] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": type });
  res.end(data);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function loadEnv() {
  const path = join(__dirname, ".env");

  if (!existsSync(path)) {
    return;
  }

  const source = readFileSync(path, "utf8");

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsAt = line.indexOf("=");

    if (equalsAt === -1) {
      continue;
    }

    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

class ApiError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const stopWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "to",
  "until",
  "when",
  "where",
  "while",
  "with"
]);

const outlineSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "genre", "tone", "logline", "hook", "themes", "acts"],
  properties: {
    title: { type: "string" },
    genre: { type: "string" },
    tone: { type: "string" },
    logline: { type: "string" },
    hook: { type: "string" },
    themes: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string" }
    },
    acts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["actNumber", "title", "summary", "emotionalBeat", "scenes"],
        properties: {
          actNumber: { type: "integer" },
          title: { type: "string" },
          summary: { type: "string" },
          emotionalBeat: { type: "string" },
          scenes: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sceneNumber", "title", "summary", "location", "timeOfDay"],
              properties: {
                sceneNumber: { type: "integer" },
                title: { type: "string" },
                summary: { type: "string" },
                location: { type: "string" },
                timeOfDay: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

const outlineSchemaGemini = {
  type: "object",
  properties: {
    title: { type: "string" },
    genre: { type: "string" },
    tone: { type: "string" },
    logline: { type: "string" },
    hook: { type: "string" },
    themes: {
      type: "array",
      items: { type: "string" }
    },
    acts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          actNumber: { type: "number" },
          title: { type: "string" },
          summary: { type: "string" },
          emotionalBeat: { type: "string" },
          scenes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sceneNumber: { type: "number" },
                title: { type: "string" },
                summary: { type: "string" },
                location: { type: "string" },
                timeOfDay: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

const storyboardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "acts"],
  properties: {
    title: { type: "string" },
    acts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["actNumber", "title", "summary", "emotionalBeat", "scenes"],
        properties: {
          actNumber: { type: "integer" },
          title: { type: "string" },
          summary: { type: "string" },
          emotionalBeat: { type: "string" },
          scenes: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sceneNumber", "title", "summary", "location", "timeOfDay", "palette", "shots"],
              properties: {
                sceneNumber: { type: "integer" },
                title: { type: "string" },
                summary: { type: "string" },
                location: { type: "string" },
                timeOfDay: { type: "string" },
                palette: { type: "string" },
                shots: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "shotNumber",
                      "title",
                      "framing",
                      "angle",
                      "movement",
                      "lighting",
                      "description",
                      "imagePrompt"
                    ],
                    properties: {
                      shotNumber: { type: "integer" },
                      title: { type: "string" },
                      framing: { type: "string" },
                      angle: { type: "string" },
                      movement: { type: "string" },
                      lighting: { type: "string" },
                      description: { type: "string" },
                      imagePrompt: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
