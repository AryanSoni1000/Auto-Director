const promptInput = document.querySelector("#promptInput");
const generateBtn = document.querySelector("#generateBtn");
const demoBtn = document.querySelector("#demoBtn");
const statusText = document.querySelector("#statusText");
const actSummaryShell = document.querySelector("#actSummaryShell");
const actSummaryCode = document.querySelector("#actSummaryCode");
const storyShell = document.querySelector("#storyShell");
const storyHeader = document.querySelector("#storyHeader");
const timeline = document.querySelector("#timeline");
const modeStrip = document.querySelector("#modeStrip");

const actTemplate = document.querySelector("#actTemplate");
const sceneTemplate = document.querySelector("#sceneTemplate");
const shotTemplate = document.querySelector("#shotTemplate");

const examplePrompt = "A futuristic heist in a high-security vault.";

demoBtn.addEventListener("click", () => {
  promptInput.value = examplePrompt;
  promptInput.focus();
});

generateBtn.addEventListener("click", handleGenerate);
promptInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    handleGenerate();
  }
});

boot();

async function boot() {
  if (window.location.protocol === "file:") {
    renderModeStrip({ textMode: "offline file", textProvider: "none", imageMode: "offline file", imageProvider: "none" });
    setStatus("This page was opened directly from disk. Start `node server.mjs` and open http://127.0.0.1:3000 instead.");
    setBusy(true);
    return;
  }

  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    renderModeStrip(payload);
    if (payload.warning) {
      setStatus(payload.warning);
    }
  } catch {
    renderModeStrip({ textMode: "demo", textProvider: "fallback", imageMode: "poster", imageProvider: "poster" });
    setStatus("The UI loaded, but the local API is unreachable. Start `node server.mjs` and open http://127.0.0.1:3000.");
  }
}

async function handleGenerate() {
  const prompt = promptInput.value.trim();

  if (!prompt) {
    setStatus("A one-line seed prompt is required before the director can begin.");
    promptInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Screenwriter is outlining the narrative, cinematographer is planning shots, and the visual artist is composing frames.");

  try {
    const response = await fetch("/api/storyboard", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Storyboard generation failed.");
    }

    renderModeStrip({
      textMode: payload.mode?.text || "demo",
      textProvider: payload.mode?.textProvider || "fallback",
      imageMode: payload.mode?.images || "poster",
      imageProvider: payload.mode?.imageProvider || "poster"
    });

    renderStory(payload.story, payload.warning);
    setStatus(payload.warning || "Storyboard ready. Scroll the feed to review every act, scene, and shot.");
  } catch (error) {
    setStatus(error.message || "Something went wrong while generating the storyboard.");
  } finally {
    setBusy(false);
  }
}

function renderModeStrip({ textMode, textProvider, imageMode, imageProvider }) {
  modeStrip.innerHTML = "";

  [
    `Text agent: ${textMode} / ${textProvider}`,
    `Visual artist: ${imageMode} / ${imageProvider}`
  ].forEach((label) => {
    const chip = document.createElement("span");
    chip.className = "mode-pill";
    chip.textContent = label;
    modeStrip.append(chip);
  });
}

function renderStory(story, warning) {
  renderActSummary(story.acts);
  storyShell.classList.remove("hidden");
  storyHeader.innerHTML = "";
  timeline.innerHTML = "";

  const kicker = document.createElement("p");
  kicker.className = "story-kicker";
  kicker.textContent = `${story.genre} / ${story.tone}`;

  const title = document.createElement("h2");
  title.className = "story-title";
  title.textContent = story.title;

  const logline = document.createElement("p");
  logline.className = "story-logline";
  logline.textContent = story.logline;

  const tagRow = document.createElement("div");
  tagRow.className = "mode-strip";

  story.themes.forEach((theme) => {
    const chip = document.createElement("span");
    chip.className = "tag";
    chip.textContent = theme;
    tagRow.append(chip);
  });

  if (warning) {
    const warningChip = document.createElement("span");
    warningChip.className = "tag";
    warningChip.textContent = warning;
    tagRow.append(warningChip);
  }

  storyHeader.append(kicker, title, logline, tagRow);

  story.acts.forEach((act, index) => {
    const actNode = actTemplate.content.firstElementChild.cloneNode(true);
    actNode.style.animationDelay = `${index * 90}ms`;
    actNode.querySelector(".act-label").textContent = `Act ${act.actNumber}`;
    actNode.querySelector(".act-title").textContent = act.title;
    actNode.querySelector(".act-summary").textContent = `${act.summary} Emotional beat: ${act.emotionalBeat}.`;

    const sceneStack = actNode.querySelector(".scene-stack");

    act.scenes.forEach((scene) => {
      const sceneNode = sceneTemplate.content.firstElementChild.cloneNode(true);
      sceneNode.querySelector(".scene-label").textContent = `Scene ${scene.sceneNumber}`;
      sceneNode.querySelector(".scene-title").textContent = scene.title;
      sceneNode.querySelector(".scene-summary").textContent = scene.summary;

      const sceneTags = sceneNode.querySelector(".scene-tags");
      [scene.location, scene.timeOfDay, scene.palette].forEach((value) => {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = value;
        sceneTags.append(tag);
      });

      const shotGrid = sceneNode.querySelector(".shot-grid");

      scene.shots.forEach((shot) => {
        const shotNode = shotTemplate.content.firstElementChild.cloneNode(true);
        const image = shotNode.querySelector(".shot-image");
        image.src = shot.visual.src;
        image.alt = shot.visual.alt;

        shotNode.querySelector(".shot-framing").textContent = shot.framing;
        shotNode.querySelector(".shot-title").textContent = shot.title;
        shotNode.querySelector(".shot-description").textContent = shot.description;

        const shotTags = shotNode.querySelector(".shot-tags");
        [shot.angle, shot.movement, shot.lighting].forEach((value) => {
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = value;
          shotTags.append(tag);
        });

        shotGrid.append(shotNode);
      });

      sceneStack.append(sceneNode);
    });

    timeline.append(actNode);
  });

  storyShell.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderActSummary(acts) {
  const labels = {
    1: "Intro",
    2: "Problem / Action",
    3: "Ending"
  };

  const lines = acts.map((act) => {
    const clean = `${act.summary}`.replace(/\s+/g, " ").trim();
    return `Act ${act.actNumber} (${labels[act.actNumber] || act.title}): ${clean}`;
  });

  actSummaryShell.classList.remove("hidden");
  actSummaryCode.textContent = lines.join("\n");
}

function setBusy(isBusy) {
  generateBtn.disabled = isBusy;
  demoBtn.disabled = isBusy;
  generateBtn.textContent = isBusy ? "Directing..." : "Direct the story";
}

function setStatus(message) {
  statusText.textContent = message;
}
