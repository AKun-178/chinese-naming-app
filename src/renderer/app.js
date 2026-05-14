const $ = (selector) => document.querySelector(selector);

const state = {
  videoPath: "",
  audioFiles: [],
  backgroundAudioPath: "",
  tailVideoPath: "",
  tailBackgroundPath: "",
  tailBuiltPath: "",
  tailSignature: "",
  outputDir: "",
  toastTimer: null,
};

const DEFAULT_VISUAL_TEXT_TEMPLATE = "{date}\n{name}\n{birthdayDigits}";
const DEFAULT_FISH_TEXT_TEMPLATE =
  "{name}缘主你好，我是{masterName}道长，你的生日是{birthdayText}，很高兴在这里与你结缘相遇，接下来由我为你详细解析。";

const settingFields = [
  "x",
  "y",
  "width",
  "height",
  "start",
  "end",
  "fontSize",
  "fontFamily",
  "visualTextTemplate",
  "fontColor",
  "boxAlpha",
  "boxColor",
  "align",
  "audioStart",
  "audioEnd",
  "crf",
];

const fishFields = [
  "fishApiKey",
  "fishReferenceId",
  "fishModel",
  "fishSpeed",
  "fishTextTemplate",
];

function value(id) {
  return $(`#${id}`).value;
}

function desktopMethod(name, fallbackName = "") {
  const api = window.desktopApi;
  const method = api?.[name] || (fallbackName ? api?.[fallbackName] : null);
  if (typeof method !== "function") {
    throw new Error("当前窗口没有加载桌面版能力。请关闭这个窗口，在终端运行 npm start 打开软件。");
  }
  return method.bind(api);
}

function reportActionError(error) {
  const message = error.message || String(error);
  setStatus("操作失败");
  showToast(message);
  return message;
}

function todayChineseDate() {
  const date = new Date();
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}号`;
}

function looksLikeDate(text) {
  return /(\d{4}|\d{6,8}|年|月|日|号)/u.test(String(text || ""));
}

function normalizeBirthday(valueText) {
  const raw = String(valueText || "").trim();
  if (!raw) return { birthdayText: "", birthdayDigits: "" };

  const compact = raw.replace(/\s+/gu, "");
  let match = /^(\d{4})(\d{2})(\d{2})$/u.exec(compact);
  if (!match) {
    match = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/u.exec(compact);
  }

  if (!match) {
    const digits = compact.replace(/\D/gu, "");
    return { birthdayText: raw, birthdayDigits: digits || raw };
  }

  const year = match[1];
  const month = String(Number(match[2]));
  const day = String(Number(match[3]));
  return {
    birthdayText: `${year}年${month}月${day}日`,
    birthdayDigits: `${year}${match[2].padStart(2, "0")}${match[3].padStart(2, "0")}`,
  };
}

function makeCustomer(parts, index) {
  const name = String(parts[0] || "").trim();
  const birthday = normalizeBirthday(parts[1] || "");
  return {
    id: String(index),
    name,
    customerName: name,
    birthday: birthday.birthdayText,
    birthdayText: birthday.birthdayText,
    birthdayDigits: birthday.birthdayDigits,
    date: String(parts[2] || "").trim() || todayChineseDate(),
    masterName: String(parts[3] || "").trim().replace(/道长$/u, "") || "天一",
  };
}

function customerRows() {
  const rows = [];
  for (const line of $("#names").value.split(/\r?\n/u)) {
    const clean = line.trim();
    if (!clean) continue;

    const parts = clean.split(/[,\uFF0C，\t|]/u).map((part) => part.trim());
    const filledParts = parts.filter(Boolean);
    if (filledParts.length > 1 && !looksLikeDate(filledParts[1])) {
      for (const name of filledParts) {
        rows.push(makeCustomer([name], rows.length));
      }
    } else {
      rows.push(makeCustomer(parts, rows.length));
    }
  }
  return rows.filter((customer) => customer.name);
}

function applyTemplate(template, customer) {
  const fields = {
    name: customer.name,
    customerName: customer.customerName || customer.name,
    date: customer.date,
    birthday: customer.birthdayText || customer.birthday,
    birthdayText: customer.birthdayText || customer.birthday,
    birthdayDigits: customer.birthdayDigits || customer.birthday,
    masterName: customer.masterName,
  };
  return String(template || "").replace(/\{(name|customerName|date|birthday|birthdayText|birthdayDigits|masterName)\}/gu, (_match, key) => fields[key] || "");
}

function settings() {
  return Object.fromEntries(settingFields.map((id) => [id, value(id)]));
}

function fishSettings() {
  return {
    enabled: $("#fishEnabled").checked,
    apiKey: value("fishApiKey").trim(),
    referenceId: value("fishReferenceId").trim(),
    model: value("fishModel"),
    speed: Number(value("fishSpeed") || 1),
    textTemplate: value("fishTextTemplate").trim(),
  };
}

function aiSettings() {
  return {
    enabled: $("#aliyunEnabled").checked,
    apiKey: value("aliyunApiKey").trim(),
    model: value("aliyunModel"),
    region: value("aliyunRegion"),
  };
}

function tailSettings() {
  return {
    enabled: $("#tailEnabled").checked,
    mode: value("tailMode") || "direct",
    videoPath: state.tailVideoPath,
    backgroundPath: state.tailBackgroundPath,
    text: value("tailTextTemplate").trim(),
    builtPath: state.tailBuiltPath,
    signature: state.tailSignature,
  };
}

function savedSettings() {
  const fish = fishSettings();
  const tail = tailSettings();
  return {
    fishEnabled: fish.enabled,
    fishApiKey: fish.apiKey,
    fishReferenceId: fish.referenceId,
    fishModel: fish.model,
    fishSpeed: fish.speed,
    fishTextTemplate: fish.textTemplate,
    tailEnabled: tail.enabled,
    tailMode: tail.mode,
    tailVideoPath: tail.videoPath,
    tailBackgroundPath: tail.backgroundPath,
    tailText: tail.text,
    tailBuiltPath: tail.builtPath,
    tailSignature: tail.signature,
    aliyunApiKey: value("aliyunApiKey").trim(),
    aliyunModel: value("aliyunModel"),
    aliyunRegion: value("aliyunRegion"),
  };
}

function setStatus(text) {
  $("#status").textContent = text;
}

function showToast(text) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function setRendering(isRendering) {
  $(".run").disabled = isRendering;
  $("#cancelRender").disabled = !isRendering;
}

function basename(filePath) {
  return String(filePath || "").split(/[\\/]/u).pop() || "";
}

function filenameStem(filePath) {
  return basename(filePath).replace(/\.[^.]+$/u, "");
}

function markTailNeedsBuild(message = "后段内容已变化，请重新生成固定后段") {
  if (value("tailMode") === "direct") {
    state.tailBuiltPath = "";
    state.tailSignature = "";
    $("#tailBuildStatus").textContent = state.tailVideoPath ? "将直接拼接已选择的后段视频" : "请选择已做好的后段视频";
    return;
  }
  state.tailBuiltPath = "";
  state.tailSignature = "";
  $("#tailBuildStatus").textContent = message;
}

function updateTailModeUi() {
  const direct = value("tailMode") === "direct";
  document.querySelectorAll(".tail-build-only").forEach((node) => {
    node.hidden = direct;
  });
  $("#pickTailVideo").textContent = direct ? "选择已做好的后段视频" : "选择后段画面视频";
  if (direct) {
    $("#tailBuildStatus").textContent = state.tailVideoPath ? "将直接拼接已选择的后段视频" : "请选择已做好的后段视频";
  } else {
    $("#tailBuildStatus").textContent = state.tailBuiltPath ? "固定后段已生成，可复用" : "还没有生成固定后段";
  }
}

function fitLines(ctx, text, width, fontSize) {
  const chars = Array.from(text);
  const lines = [];
  let line = "";
  for (const char of chars) {
    const next = line + char;
    if (ctx.measureText(next).width <= width * 0.94 || !line) {
      line = next;
    } else {
      lines.push(line);
      line = char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function textSeed(text) {
  let seed = 2166136261;
  for (const char of text) {
    seed ^= char.codePointAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function fontStack(kind, fontSize) {
  const stacks = {
    hand: `"Hanzipen SC", "HanziPen SC", "Xingkai SC", "STXingkai", "Yuanti SC", "Kaiti SC", "KaiTi", cursive`,
    kai: `"Kaiti SC", "STKaiti", "KaiTi", "SimKai", serif`,
    hei: `"PingFang SC", "Microsoft YaHei", "SimHei", sans-serif`,
  };
  return `600 ${fontSize}px ${stacks[kind] || stacks.hand}`;
}

function hexToRgb(hex) {
  const clean = String(hex || "#edbd0e").replace("#", "");
  const value = clean.length === 3 ? clean.split("").map((ch) => ch + ch).join("") : clean;
  return {
    r: parseInt(value.slice(0, 2), 16) || 237,
    g: parseInt(value.slice(2, 4), 16) || 189,
    b: parseInt(value.slice(4, 6), 16) || 14,
  };
}

function drawPaperPatch(ctx, width, height, color, seed) {
  const random = seededRandom(seed);
  const { r, g, b } = hexToRgb(color);
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y += 1) {
    const t = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      const edgeAlpha = Math.max(0, Math.min(1, edge / 8));
      const noise = Math.floor(random() * 9) - 4;
      data[i] = Math.max(0, Math.min(255, r + noise + Math.round(8 * (0.5 - t))));
      data[i + 1] = Math.max(0, Math.min(255, g + noise + Math.round(14 * (0.5 - t))));
      data[i + 2] = Math.max(0, Math.min(255, b + noise));
      data[i + 3] = Math.round(242 * edgeAlpha);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function drawHandLine(ctx, line, fontSize, centerX, y, kind, random) {
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = fontStack(kind, fontSize);
  const tracking = line.length > 6 ? -2 : 0;
  const widths = Array.from(line).map((char) => ctx.measureText(char).width);
  const total = widths.reduce((sum, width) => sum + width, 0) + tracking * Math.max(0, line.length - 1);
  let x = centerX - total / 2;
  Array.from(line).forEach((char, index) => {
    const jitterX = (random() - 0.5) * 2.2;
    const jitterY = (random() - 0.5) * 2.0;
    const angle = (random() - 0.5) * 0.12;
    ctx.save();
    ctx.translate(x + jitterX + widths[index] / 2, y + jitterY);
    ctx.rotate(angle);
    ctx.fillStyle = "rgba(18, 12, 6, 0.24)";
    ctx.fillText(char, -widths[index] / 2 + 0.4, 0.4);
    ctx.fillStyle = "rgba(31, 22, 10, 0.92)";
    ctx.fillText(char, -widths[index] / 2, 0);
    ctx.restore();
    x += widths[index] + tracking;
  });
}

function createOverlay(customer, current) {
  const canvas = $("#textCanvas");
  const width = Math.max(8, Math.round(Number(current.width) || 360));
  const height = Math.max(8, Math.round(Number(current.height) || 96));
  const displayText = applyTemplate(current.visualTextTemplate || DEFAULT_VISUAL_TEXT_TEMPLATE, customer);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (current.fontFamily === "hand") {
    drawPaperPatch(ctx, width, height, current.boxColor || "#edbd0e", textSeed(displayText));
  }
  let fontSize = Math.max(8, Math.round(Number(current.fontSize) || 48));
  let lines = [];
  let lineHeight = 0;

  while (fontSize > 8) {
    ctx.font = fontStack(current.fontFamily, fontSize);
    lines = displayText
      .split(/\r?\n/u)
      .flatMap((line) => fitLines(ctx, line, width, fontSize));
    lineHeight = Math.round(fontSize * 1.2);
    const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    if (maxWidth <= width * 0.96 && lines.length * lineHeight <= height * 0.9) break;
    fontSize -= 2;
  }

  const totalHeight = lines.length * lineHeight;
  const startY = (height - totalHeight) / 2 + lineHeight / 2;
  const x =
    current.align === "left"
      ? Math.round(width * 0.04)
      : current.align === "right"
        ? Math.round(width * 0.96)
        : Math.round(width / 2);

  lines.forEach((line, index) => {
    const lineFontSize =
      current.fontFamily === "hand" && lines.length === 3 && index === 1
        ? Math.round(fontSize * 1.35)
        : fontSize;
    if (current.fontFamily === "hand") {
      drawHandLine(ctx, line, lineFontSize, x, startY + index * lineHeight, current.fontFamily, seededRandom(textSeed(`${displayText}-${index}`)));
    } else {
      ctx.font = fontStack(current.fontFamily, lineFontSize);
      ctx.fillStyle = current.fontColor || "#ffffff";
      ctx.textBaseline = "middle";
      ctx.textAlign = current.align || "center";
      ctx.fillText(line, x, startY + index * lineHeight);
    }
  });
  return canvas.toDataURL("image/png");
}

function renderWarnings(warnings) {
  $("#warnings").innerHTML = "";
  for (const warning of warnings || []) {
    const item = document.createElement("div");
    item.className = "warning";
    item.textContent = warning;
    $("#warnings").appendChild(item);
  }
}

function renderOutputs(result) {
  const root = $("#outputs");
  root.innerHTML = "";
  const head = document.createElement("article");
  head.className = "output";
  head.innerHTML = `<h3>导出文件夹</h3><code>${result.outputDir}</code>`;
  root.appendChild(head);

  for (const output of result.outputs || []) {
    const card = document.createElement("article");
    card.className = "output";
    const audioText = output.generatedByFish ? "Fish 生成音频" : output.audioMatched ? "已换音频" : "原音频";
    const visualText = output.generatedByAi ? "AI 手写增强" : "本地手写";
    const tailText = output.tailAppended ? "已拼接固定后段" : "仅前段";
    const rangeText = output.visualRange ? `换字 ${output.visualRange}` : "换字已应用";
    const stateText = `${visualText} · ${audioText} · ${tailText} · ${rangeText}`;
    card.innerHTML = `<h3>${output.name} · ${stateText}</h3><code>${output.outputPath}</code>`;
    root.appendChild(card);
  }
}

if (window.desktopApi?.onProgress) {
  window.desktopApi.onProgress((data) => {
    $("#progressText").textContent = data.message || "";
    $("#progress").max = data.total || 1;
    $("#progress").value = data.index || 0;
  });
} else {
  $("#progressText").textContent = "请用 npm start 打开桌面版";
}

$("#pickVideo").addEventListener("click", async () => {
  try {
    setStatus("正在打开文件选择窗口");
    const file = await desktopMethod("selectVideo")();
    if (file) {
      state.videoPath = file;
      $("#videoName").textContent = basename(file);
      setStatus("模板视频已选择");
    }
  } catch (error) {
    reportActionError(error);
  }
});

$("#pickAudio").addEventListener("click", async () => {
  try {
    setStatus("正在打开文件选择窗口");
    state.audioFiles = await desktopMethod("selectAudio")();
    $("#audioName").textContent = state.audioFiles.length ? `已选择 ${state.audioFiles.length} 个音频文件` : "不选则使用 Fish Audio 或只替换画面";
    setStatus("音频已选择");
  } catch (error) {
    reportActionError(error);
  }
});

$("#pickBackgroundAudio").addEventListener("click", async () => {
  try {
    setStatus("正在打开文件选择窗口");
    const file = await desktopMethod("selectBackgroundAudio")();
    if (file) {
      state.backgroundAudioPath = file;
      $("#backgroundAudioName").textContent = basename(file);
      setStatus("背景音乐已选择");
    }
  } catch (error) {
    reportActionError(error);
  }
});

$("#pickTailVideo").addEventListener("click", async () => {
  try {
    setStatus("正在打开后段视频选择窗口");
    $("#tailBuildStatus").textContent = "正在打开后段视频选择窗口";
    const file = await desktopMethod("selectTailVideo", "selectVideo")();
    if (file) {
      state.tailVideoPath = file;
      $("#tailVideoName").textContent = basename(file);
      markTailNeedsBuild();
      setStatus(value("tailMode") === "direct" ? "后段成品视频已选择" : "后段画面视频已选择");
    }
  } catch (error) {
    $("#tailBuildStatus").textContent = reportActionError(error);
  }
});

$("#pickTailBackground").addEventListener("click", async () => {
  try {
    setStatus("正在打开后段背景选择窗口");
    $("#tailBuildStatus").textContent = "正在打开后段背景选择窗口";
    const file = await desktopMethod("selectTailBackground", "selectBackgroundAudio")();
    if (file) {
      state.tailBackgroundPath = file;
      $("#tailBackgroundName").textContent = basename(file);
      markTailNeedsBuild();
      setStatus("后段纯背景已选择");
    }
  } catch (error) {
    $("#tailBuildStatus").textContent = reportActionError(error);
  }
});

$("#pickOutput").addEventListener("click", async () => {
  try {
    setStatus("正在打开文件夹选择窗口");
    const folder = await desktopMethod("selectOutput")();
    if (folder) {
      state.outputDir = folder;
      $("#outputName").textContent = folder;
      setStatus("导出文件夹已选择");
    }
  } catch (error) {
    reportActionError(error);
  }
});

$("#saveSettings").addEventListener("click", async () => {
  try {
    await desktopMethod("writeSettings")(savedSettings());
    setStatus("Fish 设置已保存");
    showToast("Fish 设置保存成功");
  } catch (error) {
    reportActionError(error);
  }
});

$("#saveAiSettings").addEventListener("click", async () => {
  try {
    await desktopMethod("writeSettings")(savedSettings());
    setStatus("AI 设置已保存");
    showToast("AI 设置保存成功");
  } catch (error) {
    reportActionError(error);
  }
});

$("#openFishApi").addEventListener("click", async () => {
  try {
    await desktopMethod("openExternal")("fishApi");
  } catch (error) {
    reportActionError(error);
  }
});

$("#buildTailVideo").addEventListener("click", async () => {
  const fish = fishSettings();
  const tail = tailSettings();
  const button = $("#buildTailVideo");
  if (tail.mode === "direct") {
    $("#tailBuildStatus").textContent = "当前是直接拼接模式，不需要生成固定后段";
    setStatus("无需生成固定后段");
    showToast("直接拼接模式只需要选择已做好的后段视频");
    return;
  }
  if (!fish.apiKey) {
    setStatus("请先填写 Fish API Key");
    showToast("请先填写 Fish API Key");
    return;
  }
  if (!fish.referenceId) {
    setStatus("请先填写音色 ID");
    showToast("请先填写 Fish 音色 reference_id");
    return;
  }
  if (!tail.videoPath || !tail.backgroundPath || !tail.text) {
    setStatus("请先补齐固定后段");
    showToast("请选择后段视频、纯背景，并填写后段文案");
    return;
  }

  try {
    button.disabled = true;
    setRendering(true);
    $("#tailBuildStatus").textContent = "正在生成固定后段";
    setStatus("正在生成固定后段");
    const result = await desktopMethod("buildTailVideo")({
      tail,
      fish,
      crf: value("crf"),
    });
    state.tailBuiltPath = result.outputPath || "";
    state.tailSignature = result.signature || "";
    $("#tailEnabled").checked = true;
    $("#tailBuildStatus").textContent = result.warning || "固定后段已生成，可复用";
    await desktopMethod("writeSettings")(savedSettings());
    setStatus("固定后段已保存");
    showToast("固定后段生成成功");
  } catch (error) {
    const message = error.message || String(error);
    $("#tailBuildStatus").textContent = message;
    setStatus(message.includes("中断") ? "已中断" : "固定后段失败");
    showToast(message);
  } finally {
    button.disabled = false;
    setRendering(false);
  }
});

$("#cloneFishVoice").addEventListener("click", async () => {
  const apiKey = value("fishApiKey").trim();
  const button = $("#cloneFishVoice");
  const status = $("#fishCloneStatus");
  if (!apiKey) {
    setStatus("请先填写 Fish API Key");
    showToast("请先填写 Fish API Key");
    return;
  }

  try {
    button.disabled = true;
    status.textContent = "请选择一段清晰人声音频";
    const audioPath = await desktopMethod("selectVoiceSample")();
    if (!audioPath) {
      status.textContent = "已取消选择";
      return;
    }

    const title = value("fishVoiceTitle").trim() || filenameStem(audioPath) || "自定义音色";
    status.textContent = "正在克隆音色，可能需要几十秒";
    setStatus("正在克隆音色");
    const result = await desktopMethod("cloneFishVoice")({ apiKey, audioPath, title });
    $("#fishReferenceId").value = result.referenceId || "";
    $("#fishEnabled").checked = true;
    markTailNeedsBuild("音色已变化，固定后段需要重新生成");
    await desktopMethod("writeSettings")(savedSettings());
    status.textContent = `音色已创建并保存：${result.referenceId}`;
    setStatus("音色已保存");
    showToast("音色克隆成功，ID 已自动填入");
  } catch (error) {
    const message = error.message || String(error);
    status.textContent = message;
    setStatus("音色克隆失败");
    showToast(message);
  } finally {
    button.disabled = false;
  }
});

$("#openAliyunApi").addEventListener("click", async () => {
  try {
    await desktopMethod("openExternal")("aliyunApi");
  } catch (error) {
    reportActionError(error);
  }
});

$("#cancelRender").addEventListener("click", async () => {
  $("#cancelRender").disabled = true;
  setStatus("正在中断");
  $("#progressText").textContent = "正在中断当前任务";
  try {
    const cancelled = await desktopMethod("cancelRender")();
    if (!cancelled) {
      setStatus("没有运行中的任务");
    }
  } catch (error) {
    reportActionError(error);
  }
});

$("#paperPreset").addEventListener("click", () => {
  $("#x").value = "184";
  $("#y").value = "490";
  $("#width").value = "135";
  $("#height").value = "130";
  $("#start").value = "0";
  $("#end").value = "65";
  $("#fontSize").value = "16";
  $("#fontFamily").value = "hand";
  $("#visualTextTemplate").value = DEFAULT_VISUAL_TEXT_TEMPLATE;
  $("#fontColor").value = "#23160a";
  $("#boxColor").value = "#edbd0e";
  $("#boxAlpha").value = "0";
  $("#align").value = "center";
  $("#fishTextTemplate").value = DEFAULT_FISH_TEXT_TEMPLATE;
  setStatus("黄纸位置预设已恢复");
});

["tailTextTemplate", "fishReferenceId", "fishModel", "fishSpeed"].forEach((id) => {
  $(`#${id}`).addEventListener("input", () => {
    if (state.tailBuiltPath || state.tailSignature) {
      markTailNeedsBuild();
    }
  });
});

$("#tailMode").addEventListener("change", () => {
  markTailNeedsBuild();
  updateTailModeUi();
});

$("#renderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const list = customerRows();
  const current = settings();
  const overlays = Object.fromEntries(list.map((customer) => [customer.id, createOverlay(customer, current)]));

  setRendering(true);
  setStatus("生成中");
  renderWarnings([]);
  $("#outputs").innerHTML = '<p class="empty">正在生成，视频越多等待越久。</p>';

  try {
    const result = await desktopMethod("renderBatch")({
      videoPath: state.videoPath,
      audioFiles: state.audioFiles,
      backgroundAudioPath: state.backgroundAudioPath,
      outputDir: state.outputDir,
      customers: list,
      names: list.map((customer) => customer.name),
      settings: current,
      fish: fishSettings(),
      ai: aiSettings(),
      tail: tailSettings(),
      overlays,
    });
    renderWarnings(result.warnings);
    renderOutputs(result);
    setStatus("已完成");
  } catch (error) {
    const message = error.message || String(error);
    $("#outputs").innerHTML = `<p class="empty">${message}</p>`;
    setStatus(message.includes("中断") ? "已中断" : "出错");
  } finally {
    setRendering(false);
  }
});

(async function init() {
  let saved = {};
  try {
    saved = await desktopMethod("readSettings")();
  } catch (error) {
    reportActionError(error);
    return;
  }
  $("#fishEnabled").checked = Boolean(saved.fishEnabled);
  $("#fishApiKey").value = saved.fishApiKey || "";
  $("#fishReferenceId").value = saved.fishReferenceId || "";
  $("#fishModel").value = saved.fishModel || "s2-pro";
  $("#fishTextTemplate").value = saved.fishTextTemplate || DEFAULT_FISH_TEXT_TEMPLATE;
  $("#fishSpeed").value = saved.fishSpeed || 1;
  $("#tailEnabled").checked = Boolean(saved.tailEnabled);
  $("#tailMode").value = saved.tailMode || (saved.tailBuiltPath ? "build" : "direct");
  state.tailVideoPath = saved.tailVideoPath || "";
  state.tailBackgroundPath = saved.tailBackgroundPath || "";
  state.tailBuiltPath = saved.tailBuiltPath || "";
  state.tailSignature = saved.tailSignature || "";
  $("#tailVideoName").textContent = state.tailVideoPath ? basename(state.tailVideoPath) : "尚未选择";
  $("#tailBackgroundName").textContent = state.tailBackgroundPath ? basename(state.tailBackgroundPath) : "尚未选择";
  $("#tailTextTemplate").value = saved.tailText || "";
  updateTailModeUi();
  $("#aliyunApiKey").value = saved.aliyunApiKey || "";
  $("#aliyunModel").value = saved.aliyunModel || "qwen-image-2.0";
  $("#aliyunRegion").value = saved.aliyunRegion || "beijing";
})();
