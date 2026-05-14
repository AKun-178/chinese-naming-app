const { app, BrowserWindow, dialog, ipcMain, net, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Blob } = require("buffer");

const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

let mainWindow;
let activeRenderJob = null;

const DEFAULT_VISUAL_TEXT_TEMPLATE = "{date}\n{name}\n{birthdayDigits}";
const DEFAULT_FISH_TEXT_TEMPLATE =
  "{name}缘主你好，我是{masterName}道长，你的生日是{birthdayText}，很高兴在这里与你结缘相遇，接下来由我为你详细解析。";
const EXTERNAL_LINKS = {
  fishApi: "https://fish.audio/app/api-keys/",
  aliyunApi: "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 720,
    title: "视频姓名批量替换",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function resourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts);
  }
  return path.join(__dirname, "..", ...parts);
}

function unpackedPath(binaryPath) {
  if (!binaryPath) return "";
  return app.isPackaged ? binaryPath.replace("app.asar", "app.asar.unpacked") : binaryPath;
}

function ffmpegPath() {
  const bundled = resourcePath("bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(bundled)) return bundled;
  const unpacked = unpackedPath(ffmpegStatic);
  return unpacked || "ffmpeg";
}

function ffprobePath() {
  const bundled = resourcePath("bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (fs.existsSync(bundled)) return bundled;
  const unpacked = unpackedPath(ffprobeStatic.path);
  return unpacked || "ffprobe";
}

function defaultBackgroundAudioPath() {
  const candidate = resourcePath("assets", "default-background.mp4");
  return fs.existsSync(candidate) ? candidate : "";
}

function userSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function tailCacheDir() {
  return path.join(app.getPath("userData"), "fixed-tail");
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(userSettingsPath(), "utf8");
    const settings = JSON.parse(raw);
    return {
      fishEnabled: Boolean(settings.fishEnabled ?? settings.enabled ?? false),
      fishApiKey: settings.fishApiKey || settings.apiKey || "",
      fishReferenceId: settings.fishReferenceId || settings.referenceId || "",
      fishModel: settings.fishModel || settings.model || "s2-pro",
      fishTextTemplate: settings.fishTextTemplate || settings.textTemplate || DEFAULT_FISH_TEXT_TEMPLATE,
      fishSpeed: Number(settings.fishSpeed || settings.speed || 1),
      tailEnabled: Boolean(settings.tailEnabled || false),
      tailMode: settings.tailMode || (settings.tailBuiltPath ? "build" : "direct"),
      tailVideoPath: settings.tailVideoPath || "",
      tailBackgroundPath: settings.tailBackgroundPath || "",
      tailText: settings.tailText || "",
      tailBuiltPath: settings.tailBuiltPath || "",
      tailSignature: settings.tailSignature || "",
      aliyunApiKey: settings.aliyunApiKey || "",
      aliyunModel: settings.aliyunModel || "qwen-image-2.0",
      aliyunRegion: settings.aliyunRegion || "beijing",
    };
  } catch {
    return {
      fishEnabled: false,
      fishApiKey: "",
      fishReferenceId: "",
      fishModel: "s2-pro",
      fishTextTemplate: DEFAULT_FISH_TEXT_TEMPLATE,
      fishSpeed: 1,
      tailEnabled: false,
      tailMode: "direct",
      tailVideoPath: "",
      tailBackgroundPath: "",
      tailText: "",
      tailBuiltPath: "",
      tailSignature: "",
      aliyunApiKey: "",
      aliyunModel: "qwen-image-2.0",
      aliyunRegion: "beijing",
    };
  }
}

async function writeSettings(settings) {
  await fsp.mkdir(path.dirname(userSettingsPath()), { recursive: true });
  await fsp.writeFile(userSettingsPath(), JSON.stringify(settings, null, 2));
  return true;
}

function safeName(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w\-\u4e00-\u9fff]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "name";
}

async function fileFingerprint(filePath) {
  const stat = await fsp.stat(filePath);
  return {
    path: filePath,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

async function ensureReadableFile(filePath, message) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

async function tailBuildSignature({ tail, fish }) {
  const payload = {
    video: await fileFingerprint(tail.videoPath),
    background: await fileFingerprint(tail.backgroundPath),
    text: String(tail.text || "").trim(),
    referenceId: String(fish?.referenceId || "").trim(),
    model: String(fish?.model || "s2-pro"),
    speed: Number(fish?.speed || 1),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function todayChineseDate() {
  const date = new Date();
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}号`;
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

function normalizeCustomer(input, index) {
  if (typeof input === "string") {
    const birthday = normalizeBirthday("");
    return {
      id: String(index),
      name: input.trim(),
      customerName: input.trim(),
      birthday: birthday.birthdayText,
      birthdayText: birthday.birthdayText,
      birthdayDigits: birthday.birthdayDigits,
      date: todayChineseDate(),
      masterName: "天一",
    };
  }

  const name = String(input?.name || input?.customerName || "").trim();
  const birthday = normalizeBirthday(input?.birthdayText || input?.birthday || input?.birthdayDigits || "");
  return {
    id: String(input?.id ?? index),
    name,
    customerName: name,
    birthday: birthday.birthdayText,
    birthdayText: birthday.birthdayText,
    birthdayDigits: birthday.birthdayDigits,
    date: String(input?.date || "").trim() || todayChineseDate(),
    masterName: String(input?.masterName || "").trim().replace(/道长$/u, "") || "天一",
  };
}

function customersFromPayload(payload) {
  const source = Array.isArray(payload.customers) && payload.customers.length
    ? payload.customers
    : payload.names || [];
  return source.map((item, index) => normalizeCustomer(item, index)).filter((customer) => customer.name);
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorToFfmpeg(value) {
  const color = String(value || "black").trim();
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
}

function createRenderJob(sender) {
  return {
    sender,
    cancelled: false,
    children: new Set(),
    apiControllers: new Set(),
  };
}

function cancelRenderJob(job) {
  if (!job) return false;
  job.cancelled = true;
  for (const controller of job.apiControllers) {
    controller.abort();
  }
  for (const child of job.children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the click and the kill request.
    }
  }
  return true;
}

function assertNotCancelled(job) {
  if (job?.cancelled) throw new Error("任务已中断。");
}

function runProcess(command, args, onProgress, job) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error("任务已中断。"));
      return;
    }

    const child = spawn(command, args, { windowsHide: true });
    if (job) job.children.add(child);
    let stderr = "";
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (job) job.children.delete(child);
      handler(value);
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onProgress) onProgress(text);
    });
    child.on("error", (error) => {
      finish(reject, job?.cancelled ? new Error("任务已中断。") : error);
    });
    child.on("close", (code) => {
      if (job?.cancelled) finish(reject, new Error("任务已中断。"));
      else if (code === 0) finish(resolve);
      else finish(reject, new Error(stderr.slice(-3000) || `命令失败：${code}`));
    });
  });
}

async function mediaDuration(filePath, job) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error("任务已中断。"));
      return;
    }

    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    if (job) job.children.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (job) job.children.delete(child);
      handler(value);
    };

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      finish(reject, job?.cancelled ? new Error("任务已中断。") : error);
    });
    child.on("close", (code) => {
      if (job?.cancelled) finish(reject, new Error("任务已中断。"));
      else if (code === 0) finish(resolve, Number(stdout.trim()) || 0);
      else finish(reject, new Error(stderr || "无法读取媒体时长。"));
    });
  });
}

async function videoSize(filePath, job) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error("任务已中断。"));
      return;
    }

    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ];
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    if (job) job.children.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (job) job.children.delete(child);
      handler(value);
    };
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      finish(reject, job?.cancelled ? new Error("任务已中断。") : error);
    });
    child.on("close", (code) => {
      if (job?.cancelled) finish(reject, new Error("任务已中断。"));
      else if (code === 0) {
        try {
          const stream = JSON.parse(stdout)?.streams?.[0] || {};
          const width = Number(stream.width) || 0;
          const height = Number(stream.height) || 0;
          if (!width || !height) throw new Error("没有找到视频画面。");
          finish(resolve, { width, height });
        } catch (error) {
          finish(reject, error);
        }
      } else {
        finish(reject, new Error(stderr || "无法读取视频尺寸。"));
      }
    });
  });
}

async function hasAudio(filePath, job) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error("任务已中断。"));
      return;
    }

    const args = [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      filePath,
    ];
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    if (job) job.children.add(child);
    let stdout = "";
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (job) job.children.delete(child);
      handler(value);
    };
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", (error) => {
      finish(reject, job?.cancelled ? new Error("任务已中断。") : error);
    });
    child.on("close", () => {
      if (job?.cancelled) finish(reject, new Error("任务已中断。"));
      else finish(resolve, Boolean(stdout.trim()));
    });
  });
}

async function writeDataUrl(dataUrl, filePath) {
  const match = /^data:image\/png;base64,(.+)$/u.exec(dataUrl || "");
  if (!match) throw new Error("文字图片生成失败。");
  await fsp.writeFile(filePath, Buffer.from(match[1], "base64"));
}

async function encodeImageDataUrl(filePath) {
  const data = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${data.toString("base64")}`;
}

function apiHost(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function networkHint(provider) {
  if (String(provider).startsWith("Fish Audio")) {
    return "请确认这台 Windows 电脑能访问 Fish Audio；如果浏览器靠代理才能访问，请先开启系统代理后再试。";
  }
  if (provider === "阿里云百炼") {
    return "请确认百炼 API Key、地域选择和当前网络可用。";
  }
  return "请确认当前网络可用后再试。";
}

async function requestApi(url, options = {}, provider = "API", timeoutMs = 120000, job = null) {
  assertNotCancelled(job);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = typeof net?.fetch === "function" ? net.fetch.bind(net) : fetch;
  if (job) job.apiControllers.add(controller);

  try {
    return await request(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (job?.cancelled) throw new Error("任务已中断。");
    const detail = error?.name === "AbortError"
      ? "请求超时"
      : error?.cause?.message || error?.message || String(error);
    throw new Error(`${provider} 请求失败：无法连接 ${apiHost(url)}。${networkHint(provider)} 原始错误：${detail}`);
  } finally {
    clearTimeout(timer);
    if (job) job.apiControllers.delete(controller);
  }
}

async function downloadFile(url, filePath, job) {
  const response = await requestApi(url, {}, "图片下载", 120000, job);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`下载生成图片失败：HTTP ${response.status} ${detail}`);
  }
  await fsp.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return filePath;
}

function dashscopeEndpoint(region) {
  return region === "intl"
    ? "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    : "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
}

async function extractPatchReference({ videoPath, settings, jobDir, name, job }) {
  assertNotCancelled(job);
  const x = Math.max(0, Math.round(asNumber(settings.x, 80)));
  const y = Math.max(0, Math.round(asNumber(settings.y, 80)));
  const width = Math.max(8, Math.round(asNumber(settings.width, 360)));
  const height = Math.max(8, Math.round(asNumber(settings.height, 96)));
  const start = Math.max(0, asNumber(settings.start, 0));
  const requestedEnd = asNumber(settings.end, 65);
  const duration = await mediaDuration(videoPath, job);
  const targetTime = requestedEnd > start + 0.05 ? requestedEnd - 0.2 : start + 5;
  const shotTime = Math.max(0, Math.min(duration > 0 ? Math.max(0, duration - 0.2) : targetTime, targetTime));
  const cropPath = path.join(jobDir, `${safeName(name)}_ai_reference.png`);
  const cleanCropPath = path.join(jobDir, `${safeName(name)}_ai_reference_clean.png`);
  const scaleWidth = Math.max(768, Math.round((width / height) * 768));
  const scaleHeight = 768;
  await runProcess(ffmpegPath(), [
    "-y",
    "-ss",
    String(shotTime),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    `crop=${width}:${height}:${x}:${y},scale=${scaleWidth}:${scaleHeight}:flags=lanczos`,
    cropPath,
  ], null, job);
  const paperColor = colorToFfmpeg(settings.boxColor || "#edbd0e");
  const cleanFilter = [
    `drawbox=x=0:y=0:w=iw:h=ih*0.34:color=${paperColor}:t=fill`,
    `drawbox=x=0:y=ih*0.30:w=iw:h=ih*0.35:color=${paperColor}:t=fill`,
    `drawbox=x=0:y=ih*0.59:w=iw*0.9:h=ih*0.32:color=${paperColor}:t=fill`,
  ].join(",");
  await runProcess(ffmpegPath(), [
    "-y",
    "-i",
    cropPath,
    "-vf",
    cleanFilter,
    cleanCropPath,
  ], null, job);
  return { cropPath: cleanCropPath, originalCropPath: cropPath, scaleWidth, scaleHeight, width, height };
}

function visualTextForCustomer(template, customer) {
  return applyTemplate(template || DEFAULT_VISUAL_TEXT_TEMPLATE, customer);
}

async function aliyunImageEditPatch({ videoPath, customer, settings, ai, jobDir, job }) {
  assertNotCancelled(job);
  if (!ai?.apiKey) throw new Error("请填写阿里云百炼 API Key。");
  const model = ai.model || "qwen-image-2.0";
  const name = customer.name;
  const { cropPath, originalCropPath, scaleWidth, scaleHeight, width, height } = await extractPatchReference({
    videoPath,
    settings,
    jobDir,
    name,
    job,
  });
  const originalReferenceImage = await encodeImageDataUrl(originalCropPath);
  const cleanReferenceImage = await encodeImageDataUrl(cropPath);
  const visualText = visualTextForCustomer(settings.visualTextTemplate, customer);
  const lines = visualText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const lineText = lines.map((line, index) => `第${index + 1}行「${line}」`).join("，");
  const prompt = [
    "第一张图用于参考原始黄纸纹理、光照和手写笔迹风格；第二张图是旧字已被黄色纸面预清理后的干净底稿。",
    "请以第二张干净底稿为基础生成结果，只重新写入三行新文字，不要恢复第一张里的旧字痕迹。",
    "先彻底擦除原有三行文字，包括淡淡的残影、重影、拖影和旧字阴影，再写入新的三行文字。",
    `把三行原字按原来的位置、行距和大小分别替换为${lineText}。`,
    "新文字必须模仿参考图里的真实手写笔迹、笔画粗细、倾斜角度和墨色，不要像印刷字体或电脑字体。",
    "每一行只能出现一套清晰文字，尤其第一行日期不能双写、不能有上方重影、不能留下旧日期笔画。",
    "三行文字必须控制在原字大小附近，落在原来日期、姓名、生日的位置，不要变大，不要超出黄纸，不要挤到顶部，不要重新居中排版。",
    "修图边缘必须自然融入纸张纹理，不要出现矩形贴片、色块边框或像后贴上去的一层图片。",
    "不要改变红色印章、符号、边缘和背景。",
  ].join("");

  const response = await requestApi(dashscopeEndpoint(ai.region), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ai.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [{ image: originalReferenceImage }, { image: cleanReferenceImage }, { text: prompt }],
          },
        ],
      },
      parameters: {
        n: 1,
        negative_prompt: "印刷体，电脑字体，打字效果，居中排版，文字过大，文字超出黄纸，文字挤到顶部，重影，残影，拖影，旧字残留，旧日期残留，双层文字，双写日期，重复笔画，模糊笔画，矩形贴片，色块边框，边缘突兀，像粘贴图片，错别字，多余文字，水印，改变印章，改变背景，低清晰度",
        prompt_extend: false,
        watermark: false,
        size: `${scaleWidth}*${scaleHeight}`,
      },
    }),
  }, "阿里云百炼", 180000, job);

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code) {
    throw new Error(`阿里云图像编辑失败：${payload?.message || response.status}`);
  }
  const imageUrl = payload?.output?.choices?.[0]?.message?.content?.find((item) => item.image)?.image;
  if (!imageUrl) throw new Error("阿里云图像编辑没有返回图片。");

  const rawPath = path.join(jobDir, `${safeName(name)}_ai_raw.png`);
  const patchPath = path.join(jobDir, `${safeName(name)}_ai_patch.png`);
  await downloadFile(imageUrl, rawPath, job);
  assertNotCancelled(job);
  await runProcess(ffmpegPath(), [
    "-y",
    "-i",
    rawPath,
    "-vf",
    `scale=${width}:${height}:flags=lanczos,format=rgba`,
    patchPath,
  ], null, job);
  return patchPath;
}

async function fishAudioTts({ text, apiKey, referenceId, model, speed, outputPath, job }) {
  assertNotCancelled(job);
  if (!apiKey) throw new Error("请填写 Fish Audio API Key。");
  if (!referenceId) throw new Error("请填写 Fish Audio 音色 reference_id。");

  const response = await requestApi("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: model || "s2-pro",
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      temperature: 0.7,
      top_p: 0.7,
      prosody: {
        speed: clamp(asNumber(speed, 1), 0.5, 2),
        volume: 0,
        normalize_loudness: true,
      },
      chunk_length: 300,
      normalize: true,
      format: "mp3",
      sample_rate: 44100,
      mp3_bitrate: 128,
      latency: "normal",
      max_new_tokens: 1024,
      repetition_penalty: 1.2,
      min_chunk_length: 50,
      condition_on_previous_chunks: true,
    }),
  }, "Fish Audio", 180000, job);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Fish Audio 生成失败：HTTP ${response.status} ${detail}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const data = Buffer.from(await response.arrayBuffer());
  if (contentType.includes("json")) {
    throw new Error(`Fish Audio 没有返回音频：${data.toString("utf8")}`);
  }
  if (!data.length) throw new Error("Fish Audio 返回了空音频。");
  await fsp.writeFile(outputPath, data);
  return outputPath;
}

function mimeForAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
  };
  return types[ext] || "application/octet-stream";
}

async function fishCloneVoiceModel({ apiKey, audioPath, title }) {
  if (!apiKey) throw new Error("请先填写 Fish Audio API Key。");
  if (!audioPath) throw new Error("请先选择一段授权音频。");
  await fsp.access(audioPath, fs.constants.R_OK);

  const audioData = await fsp.readFile(audioPath);
  const fileName = path.basename(audioPath);
  const modelTitle = String(title || path.basename(audioPath, path.extname(audioPath)) || "自定义音色").trim().slice(0, 80);
  const form = new FormData();
  form.append("title", modelTitle);
  form.append("description", "由视频姓名批量替换软件创建的授权音色");
  form.append("visibility", "private");
  form.append("type", "tts");
  form.append("train_mode", "fast");
  form.append("enhance_audio_quality", "true");
  form.append("voices", new Blob([audioData], { type: mimeForAudio(audioPath) }), fileName);

  const response = await requestApi("https://api.fish.audio/model", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  }, "Fish Audio 音色克隆", 300000);

  const responseText = await response.text();
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const detail = payload?.message || payload?.detail || responseText || response.status;
    throw new Error(`Fish Audio 音色克隆失败：HTTP ${response.status} ${detail}`);
  }

  const referenceId = payload?._id || payload?.id || payload?.model?._id || payload?.model?.id;
  if (!referenceId) throw new Error("Fish Audio 已返回结果，但没有找到音色 ID。");
  return {
    referenceId,
    state: payload?.state || "",
    title: payload?.title || modelTitle,
  };
}

function audioClipMap(files) {
  const map = new Map();
  for (const file of files || []) {
    map.set(safeName(path.basename(file, path.extname(file))), file);
  }
  return map;
}

function finalVideoOutputPath(videoPath, name, outputDir) {
  return path.join(outputDir, `${path.basename(videoPath, path.extname(videoPath))}_${safeName(name)}.mp4`);
}

function atempoChain(tempo) {
  if (tempo <= 1.001) return "";
  const parts = [];
  let remaining = tempo;
  while (remaining > 2) {
    parts.push("atempo=2");
    remaining /= 2;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return `${parts.join(",")},`;
}

function visualTiming(settings, duration) {
  const start = Math.max(0, asNumber(settings.start, 0));
  const requestedEnd = asNumber(settings.end, 65);
  const end = requestedEnd > start + 0.05
    ? Math.min(duration || requestedEnd, requestedEnd)
    : (duration || start + 65);
  return {
    start,
    end: Math.max(start + 0.05, end),
  };
}

function voiceTempoForSegment({ name, clipDuration, segmentDuration, warnings, context }) {
  if (clipDuration <= segmentDuration + 0.05) return 1;
  const requiredTempo = clipDuration / segmentDuration;
  if (requiredTempo <= 1.35) {
    warnings?.push(`${name} 的语音已自动加速 ${requiredTempo.toFixed(2)} 倍，避免${context}被截断。`);
    return requiredTempo;
  }
  throw new Error(`${name} 的语音 ${clipDuration.toFixed(1)} 秒，可用时间只有 ${segmentDuration.toFixed(1)} 秒，放不下。请缩短 Fish 文案或提高语速。`);
}

async function renderBaseVideo({ videoPath, name, audioClip, backgroundAudioPath, settings, outputDir, outputPath, warnings, job }) {
  assertNotCancelled(job);
  const duration = await mediaDuration(videoPath, job);
  const audioStart = duration > 0
    ? Math.min(duration, Math.max(0, asNumber(settings.audioStart, 0)))
    : Math.max(0, asNumber(settings.audioStart, 0));
  const requestedAudioEnd = asNumber(settings.audioEnd, 0);
  const autoAudioEnd = requestedAudioEnd <= audioStart;
  let audioEnd = requestedAudioEnd > audioStart ? requestedAudioEnd : audioStart;
  let audioClipDuration = 0;
  let voiceTempo = 1;
  if (audioClip) {
    audioClipDuration = await mediaDuration(audioClip, job);
    const frontEnd = duration > 0 ? duration : audioStart + Math.max(0.05, audioClipDuration);
    const availableDuration = Math.max(0.05, frontEnd - audioStart);
    if (autoAudioEnd) {
      const segment = Math.min(availableDuration, Math.max(0.05, audioClipDuration || 0.05));
      voiceTempo = voiceTempoForSegment({
        name,
        clipDuration: audioClipDuration,
        segmentDuration: segment,
        warnings,
        context: "最后一句",
      });
      audioEnd = audioStart + segment;
    } else {
      audioEnd = Math.min(frontEnd, requestedAudioEnd);
      const segment = Math.max(0.05, audioEnd - audioStart);
      voiceTempo = voiceTempoForSegment({
        name,
        clipDuration: audioClipDuration,
        segmentDuration: segment,
        warnings,
        context: "替换结束秒",
      });
    }
  }
  if (duration > 0) {
    audioEnd = Math.min(duration, audioEnd);
  }
  const crf = Math.round(clamp(asNumber(settings.crf, 15), 10, 35));
  const finalPath = outputPath || finalVideoOutputPath(videoPath, name, outputDir);

  const args = [
    "-y",
    "-i",
    videoPath,
  ];

  let filterComplex = "[0:v]format=yuv420p[v]";
  let audioArgs = ["-map", "0:a?", "-c:a", "copy"];
  let backgroundIndex = null;
  let voiceIndex = null;

  if (backgroundAudioPath) {
    args.push("-stream_loop", "-1", "-i", backgroundAudioPath);
    backgroundIndex = 1;
  }

  if (audioClip && audioEnd > audioStart) {
    const segment = audioEnd - audioStart;
    const delayMs = Math.round(audioStart * 1000);
    args.push("-i", audioClip);
    voiceIndex = backgroundIndex ? 2 : 1;
    const tempo = atempoChain(voiceTempo);

    if (backgroundIndex) {
      const backgroundDuration = Math.max(duration || segment, audioEnd);
      filterComplex +=
        `;[${backgroundIndex}:a]aresample=48000,volume=0.72,atrim=0:${backgroundDuration},asetpts=PTS-STARTPTS[bgm];` +
        `[${voiceIndex}:a]aresample=48000,volume=1.35,${tempo}atrim=0:${segment},asetpts=PTS-STARTPTS,apad,atrim=0:${segment},adelay=${delayMs}:all=1[rep];` +
        `[bgm][rep]amix=inputs=2:duration=first:dropout_transition=0[a]`;
    } else if (await hasAudio(videoPath, job)) {
      filterComplex +=
        `;[0:a]volume=enable='between(t\\,${audioStart}\\,${audioEnd})':volume=0.22[ducked];` +
        `[${voiceIndex}:a]aresample=48000,volume=1.35,${tempo}atrim=0:${segment},asetpts=PTS-STARTPTS,apad,atrim=0:${segment},adelay=${delayMs}:all=1[rep];` +
        `[ducked][rep]amix=inputs=2:duration=first:dropout_transition=0[a]`;
    } else {
      const audioPadDuration = Math.max(duration || segment, audioStart + segment);
      filterComplex +=
        `;[${voiceIndex}:a]aresample=48000,volume=1.35,${tempo}atrim=0:${segment},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,apad,atrim=0:${audioPadDuration}[a]`;
    }
    audioArgs = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"];
  } else if (backgroundIndex) {
    const backgroundDuration = Math.max(duration || 0.05, 0.05);
    filterComplex += `;[${backgroundIndex}:a]aresample=48000,volume=0.72,atrim=0:${backgroundDuration},asetpts=PTS-STARTPTS[a]`;
    audioArgs = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"];
  }

  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    ...audioArgs,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    ...(duration > 0 ? ["-t", String(duration)] : []),
    "-movflags",
    "+faststart",
    finalPath,
  );

  await runProcess(ffmpegPath(), args, null, job);
  return finalPath;
}

async function applyVisualPatchToVideo({ videoPath, name, overlayDataUrl, overlayFilePath, settings, outputPath, jobDir, job }) {
  assertNotCancelled(job);
  const id = crypto.randomUUID();
  const patchPath = overlayFilePath || path.join(jobDir, `${id}_${safeName(name)}_visual.png`);
  if (!overlayFilePath) await writeDataUrl(overlayDataUrl, patchPath);

  const duration = await mediaDuration(videoPath, job);
  const x = Math.max(0, Math.round(asNumber(settings.x, 80)));
  const y = Math.max(0, Math.round(asNumber(settings.y, 80)));
  const width = Math.max(8, Math.round(asNumber(settings.width, 360)));
  const height = Math.max(8, Math.round(asNumber(settings.height, 96)));
  const { start, end } = visualTiming(settings, duration);
  const crf = Math.round(clamp(asNumber(settings.crf, 15), 10, 35));
  const enable = `between(t\\,${start}\\,${end})`;
  const feather = Math.max(4, Math.min(18, Math.round(Math.min(width, height) * 0.08)));
  const blur = Math.max(3, Math.round(feather * 0.75));
  const filterComplex =
    `[1:v]format=rgba,scale=${width}:${height}:flags=lanczos,split[p][m];` +
    `[m]alphaextract,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=${feather},boxblur=${blur}:1[mask];` +
    "[p][mask]alphamerge[patch];" +
    `[0:v][patch]overlay=x=${x}:y=${y}:enable='${enable}'[v]`;

  await runProcess(ffmpegPath(), [
    "-y",
    "-i",
    videoPath,
    "-loop",
    "1",
    "-t",
    String(duration),
    "-i",
    patchPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ], null, job);

  return {
    outputPath,
    visualRange: `${start.toFixed(1)}-${end.toFixed(1)}秒`,
  };
}

async function renderFixedTailVideo({ videoPath, backgroundPath, voicePath, outputPath, crf, job }) {
  assertNotCancelled(job);
  const duration = await mediaDuration(videoPath, job);
  if (duration <= 0) throw new Error("后段画面视频无法读取时长。");
  if (!(await hasAudio(backgroundPath, job))) {
    throw new Error("后段纯背景文件没有可用声音，请选择带背景声的音频或视频。");
  }

  const voiceDuration = await mediaDuration(voicePath, job);
  const safeDuration = Math.max(0.05, duration);
  const safeCrf = Math.round(clamp(asNumber(crf, 15), 10, 35));
  const filterComplex =
    `[0:v]trim=0:${safeDuration},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,fps=30,format=yuv420p[v];` +
    `[1:a]aresample=48000,volume=0.72,atrim=0:${safeDuration},asetpts=PTS-STARTPTS[bgm];` +
    `[2:a]aresample=48000,volume=1.35,atrim=0:${safeDuration},asetpts=PTS-STARTPTS,apad,atrim=0:${safeDuration}[voice];` +
    "[bgm][voice]amix=inputs=2:duration=first:dropout_transition=0[a]";

  await runProcess(ffmpegPath(), [
    "-y",
    "-i",
    videoPath,
    "-stream_loop",
    "-1",
    "-i",
    backgroundPath,
    "-i",
    voicePath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    String(safeDuration),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(safeCrf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ], null, job);

  return voiceDuration > safeDuration + 0.2
    ? "固定后段已生成，但语音比后段视频长，结尾会被截断"
    : "";
}

async function buildFixedTailVideo({ tail, fish, crf, job, sender }) {
  const videoPath = String(tail?.videoPath || "").trim();
  const backgroundPath = String(tail?.backgroundPath || "").trim();
  const text = String(tail?.text || "").trim();
  if (!videoPath) throw new Error("请选择后段画面视频。");
  if (!backgroundPath) throw new Error("请选择后段纯背景音/视频。");
  if (!text) throw new Error("请填写后段固定文案。");
  if (!fish?.apiKey) throw new Error("请填写 Fish Audio API Key。");
  if (!fish?.referenceId) throw new Error("请填写 Fish Audio 音色 reference_id。");
  await ensureReadableFile(videoPath, "后段画面视频不存在或无法读取，请重新选择。");
  await ensureReadableFile(backgroundPath, "后段纯背景音/视频不存在或无法读取，请重新选择。");

  const normalizedTail = { videoPath, backgroundPath, text };
  const signature = await tailBuildSignature({ tail: normalizedTail, fish });
  const cacheDir = tailCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });
  const id = signature.slice(0, 16);
  const voicePath = path.join(cacheDir, `fixed-tail-${id}.mp3`);
  const outputPath = path.join(cacheDir, `fixed-tail-${id}.mp4`);

  if (fs.existsSync(outputPath)) {
    return {
      outputPath,
      signature,
      reused: true,
      warning: "",
    };
  }

  sender?.send("render:progress", {
    index: 0,
    total: 1,
    message: "正在生成固定后段语音",
  });
  await fishAudioTts({
    text,
    apiKey: fish.apiKey,
    referenceId: fish.referenceId,
    model: fish.model,
    speed: fish.speed,
    outputPath: voicePath,
    job,
  });

  sender?.send("render:progress", {
    index: 0,
    total: 1,
    message: "正在合成固定后段",
  });
  const warning = await renderFixedTailVideo({
    videoPath,
    backgroundPath,
    voicePath,
    outputPath,
    crf,
    job,
  });

  return {
    outputPath,
    signature,
    reused: false,
    warning,
  };
}

async function validateTailForBatch(tail, fish) {
  if (!tail?.enabled) return null;
  const mode = tail.mode || (tail.builtPath ? "build" : "direct");
  if (mode === "direct") {
    const directPath = String(tail.videoPath || "").trim();
    if (!directPath) throw new Error("请选择已做好的后段视频。");
    await ensureReadableFile(directPath, "已选择的后段视频不存在或无法读取，请重新选择。");
    return directPath;
  }

  const builtPath = String(tail.builtPath || "").trim();
  if (!builtPath || !tail.signature) {
    throw new Error("请先点击“生成/更新固定后段”，再开始批量生成。");
  }
  await ensureReadableFile(builtPath, "固定后段成品文件找不到了，请重新生成固定后段。");

  if (tail.videoPath && tail.backgroundPath && tail.text) {
    try {
      const expected = await tailBuildSignature({ tail, fish });
      if (expected !== tail.signature) {
        throw new Error("固定后段内容或音色已变化，请先重新生成固定后段。");
      }
    } catch (error) {
      if (error.message.includes("固定后段内容")) throw error;
    }
  }
  return builtPath;
}

async function concatWithFixedTail({ frontPath, tailPath, outputPath, crf, job }) {
  assertNotCancelled(job);
  const size = await videoSize(frontPath, job);
  const frontDuration = Math.max(0.05, await mediaDuration(frontPath, job));
  const tailDuration = Math.max(0.05, await mediaDuration(tailPath, job));
  const width = Math.max(2, Math.floor(size.width / 2) * 2);
  const height = Math.max(2, Math.floor(size.height / 2) * 2);
  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
  const safeCrf = Math.round(clamp(asNumber(crf, 15), 10, 35));
  const filterComplex =
    `[0:v]trim=0:${frontDuration},setpts=PTS-STARTPTS,${scalePad}[v0];` +
    `[1:v]trim=0:${tailDuration},setpts=PTS-STARTPTS,${scalePad}[v1];` +
    `[0:a]atrim=0:${frontDuration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];` +
    `[1:a]atrim=0:${tailDuration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];` +
    "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]";

  await runProcess(ffmpegPath(), [
    "-y",
    "-i",
    frontPath,
    "-i",
    tailPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(safeCrf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(frontDuration + tailDuration + 0.05),
    "-movflags",
    "+faststart",
    outputPath,
  ], null, job);

  return outputPath;
}

ipcMain.handle("settings:read", readSettings);
ipcMain.handle("settings:write", async (_event, settings) => writeSettings(settings));

ipcMain.handle("open:external", async (_event, target) => {
  const url = EXTERNAL_LINKS[target] || String(target || "");
  if (!/^https:\/\//u.test(url)) throw new Error("无法打开这个链接。");
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("render:cancel", async (event) => {
  if (!activeRenderJob || activeRenderJob.sender !== event.sender) return false;
  event.sender.send("render:progress", {
    index: 0,
    total: 1,
    message: "正在中断当前任务",
  });
  return cancelRenderJob(activeRenderJob);
});

ipcMain.handle("dialog:video", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择模板视频",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "mkv", "webm"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:audio", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择同名音频",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "音频", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:backgroundAudio", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择背景音乐",
    properties: ["openFile"],
    filters: [{ name: "音频", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:tailVideo", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择固定后段画面视频",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "mkv", "webm"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:tailBackground", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择固定后段纯背景音或视频",
    properties: ["openFile"],
    filters: [{ name: "音频或视频", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "mp4", "mov", "m4v", "mkv", "webm"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:voiceSample", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择用于克隆音色的人声音频",
    properties: ["openFile"],
    filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:output", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择导出文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("fish:cloneVoice", async (_event, payload) => fishCloneVoiceModel(payload));

ipcMain.handle("tail:build", async (event, payload) => {
  if (activeRenderJob) throw new Error("已有任务正在生成，请先中断或等待完成。");

  const renderJob = createRenderJob(event.sender);
  activeRenderJob = renderJob;
  try {
    const result = await buildFixedTailVideo({
      tail: payload.tail,
      fish: payload.fish,
      crf: payload.crf,
      job: renderJob,
      sender: event.sender,
    });
    event.sender.send("render:progress", {
      index: 1,
      total: 1,
      message: result.reused ? "固定后段已存在，可复用" : "固定后段已完成",
    });
    return result;
  } finally {
    if (activeRenderJob === renderJob) {
      activeRenderJob = null;
    }
  }
});

ipcMain.handle("render:batch", async (event, payload) => {
  if (activeRenderJob) throw new Error("已有任务正在生成，请先中断或等待完成。");

  const customers = customersFromPayload(payload);
  if (!payload.videoPath) throw new Error("请先选择模板视频。");
  if (!customers.length) throw new Error("请至少输入一个客户姓名。");
  if (!payload.outputDir) throw new Error("请选择导出文件夹。");
  if (payload.ai?.enabled && !payload.ai.apiKey) throw new Error("请先填写百炼 API Key，画面手写替换需要调用图片 API。");
  if (payload.fish?.enabled && !payload.fish.apiKey) throw new Error("请先填写 Fish Audio API Key。");
  if (payload.fish?.enabled && !payload.fish.referenceId) throw new Error("请先填写 Fish Audio 音色 reference_id。");
  const fixedTailPath = await validateTailForBatch(payload.tail, payload.fish);
  const backgroundAudioPath = payload.backgroundAudioPath || defaultBackgroundAudioPath();

  const renderJob = createRenderJob(event.sender);
  activeRenderJob = renderJob;
  const batchId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(payload.outputDir, `视频批量替换_${batchId}`);
  const jobDir = path.join(os.tmpdir(), `video-name-batcher-${batchId}`);

  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.mkdir(jobDir, { recursive: true });

    const clips = audioClipMap(payload.audioFiles || []);
    const outputs = [];
    const warnings = [];

    for (let index = 0; index < customers.length; index += 1) {
      assertNotCancelled(renderJob);
      const customer = customers[index];
      const name = customer.name;
      event.sender.send("render:progress", {
        index,
        total: customers.length,
        name,
        message: `正在处理 ${name}`,
      });

      let audioClip = clips.get(safeName(name));
      let generatedByFish = false;
      const audioMatched = Boolean(audioClip);

      if (!audioClip && payload.fish?.enabled) {
        const text = applyTemplate(payload.fish.textTemplate || DEFAULT_FISH_TEXT_TEMPLATE, customer);
        audioClip = path.join(jobDir, `${safeName(name)}_fish.mp3`);
        await fishAudioTts({
          text,
          apiKey: payload.fish.apiKey,
          referenceId: payload.fish.referenceId,
          model: payload.fish.model,
          speed: payload.fish.speed,
          outputPath: audioClip,
          job: renderJob,
        });
        generatedByFish = true;
      } else if ((payload.audioFiles || []).length && !audioClip) {
        warnings.push(`${name} 没有找到同名音频文件，已只替换画面文字。`);
      }

      assertNotCancelled(renderJob);
      const finalOutputPath = finalVideoOutputPath(payload.videoPath, name, outputDir);
      const frontOutputPath = path.join(jobDir, `${safeName(name)}_front.mp4`);
      const frontPath = await renderBaseVideo({
        videoPath: payload.videoPath,
        name,
        audioClip,
        backgroundAudioPath,
        settings: payload.settings,
        outputDir,
        outputPath: frontOutputPath,
        warnings,
        job: renderJob,
      });

      let composedPath = frontPath;
      if (fixedTailPath) {
        event.sender.send("render:progress", {
          index,
          total: customers.length,
          name,
          message: `正在拼接 ${name} 的固定后段`,
        });
        composedPath = await concatWithFixedTail({
          frontPath,
          tailPath: fixedTailPath,
          outputPath: path.join(jobDir, `${safeName(name)}_composed.mp4`),
          crf: payload.settings?.crf,
          job: renderJob,
        });
      }

      let overlayFilePath = null;
      let generatedByAi = false;
      if (payload.ai?.enabled) {
        event.sender.send("render:progress", {
          index,
          total: customers.length,
          name,
          message: `AI 正在按完整视频生成 ${name} 的手写补丁`,
        });
        try {
          overlayFilePath = await aliyunImageEditPatch({
            videoPath: composedPath,
            customer,
            settings: payload.settings,
            ai: payload.ai,
            jobDir,
            job: renderJob,
          });
          generatedByAi = true;
        } catch (error) {
          warnings.push(`${name} 的 AI 手写补丁生成失败，已使用本地手写兜底：${error.message || String(error)}`);
        }
      }

      event.sender.send("render:progress", {
        index,
        total: customers.length,
        name,
        message: `正在融合 ${name} 的黄纸文字`,
      });
      const visualResult = await applyVisualPatchToVideo({
        videoPath: composedPath,
        name,
        overlayDataUrl: payload.overlays?.[customer.id] || payload.overlays?.[name],
        overlayFilePath,
        settings: payload.settings,
        outputPath: finalOutputPath,
        jobDir,
        job: renderJob,
      });

      outputs.push({
        name,
        outputPath: visualResult.outputPath,
        audioMatched,
        generatedByFish,
        generatedByAi,
        tailAppended: Boolean(fixedTailPath),
        visualRange: visualResult.visualRange,
      });
    }

    event.sender.send("render:progress", {
      index: customers.length,
      total: customers.length,
      message: "已完成",
    });

    return { outputDir, outputs, warnings };
  } finally {
    if (activeRenderJob === renderJob) {
      activeRenderJob = null;
    }
  }
});
