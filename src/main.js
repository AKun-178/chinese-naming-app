const { app, BrowserWindow, dialog, ipcMain, net, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

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

function userSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(userSettingsPath(), "utf8");
    const settings = JSON.parse(raw);
    return {
      fishApiKey: settings.fishApiKey || "",
      fishReferenceId: settings.fishReferenceId || "",
      fishModel: settings.fishModel || "s2-pro",
      fishTextTemplate: settings.fishTextTemplate || DEFAULT_FISH_TEXT_TEMPLATE,
      fishSpeed: Number(settings.fishSpeed || 1),
      aliyunApiKey: settings.aliyunApiKey || "",
      aliyunModel: settings.aliyunModel || "qwen-image-2.0",
      aliyunRegion: settings.aliyunRegion || "beijing",
    };
  } catch {
    return {
      fishApiKey: "",
      fishReferenceId: "",
      fishModel: "s2-pro",
      fishTextTemplate: DEFAULT_FISH_TEXT_TEMPLATE,
      fishSpeed: 1,
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
  if (provider === "Fish Audio") {
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
  const duration = await mediaDuration(videoPath, job);
  const shotTime = Math.max(0, Math.min(duration > 0 ? duration - 0.2 : start + 5, start + 5));
  const cropPath = path.join(jobDir, `${safeName(name)}_ai_reference.png`);
  const scaleWidth = Math.max(512, Math.round((width / height) * 512));
  const scaleHeight = 512;
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
  return { cropPath, scaleWidth, scaleHeight, width, height };
}

function visualTextForCustomer(template, customer) {
  return applyTemplate(template || DEFAULT_VISUAL_TEXT_TEMPLATE, customer);
}

async function aliyunImageEditPatch({ videoPath, customer, settings, ai, jobDir, job }) {
  assertNotCancelled(job);
  if (!ai?.apiKey) throw new Error("请填写阿里云百炼 API Key。");
  const model = ai.model || "qwen-image-2.0";
  const name = customer.name;
  const { cropPath, scaleWidth, scaleHeight, width, height } = await extractPatchReference({
    videoPath,
    settings,
    jobDir,
    name,
    job,
  });
  const referenceImage = await encodeImageDataUrl(cropPath);
  const visualText = visualTextForCustomer(settings.visualTextTemplate, customer);
  const lines = visualText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const lineText = lines.map((line, index) => `第${index + 1}行「${line}」`).join("，");
  const prompt = [
    "只编辑图中的黄纸手写文字区域，保持黄纸颜色、纸张纹理、光照、透视、阴影和周围内容不变。",
    `把原有手写内容替换为${lineText}。`,
    "新文字必须是深色签字笔手写风格，像真实手写在黄纸上，不要像印刷字体，不要生成额外文字。",
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
            content: [{ image: referenceImage }, { text: prompt }],
          },
        ],
      },
      parameters: {
        n: 1,
        negative_prompt: "印刷体，电脑字体，错别字，多余文字，水印，改变印章，改变背景，低清晰度",
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

function audioClipMap(files) {
  const map = new Map();
  for (const file of files || []) {
    map.set(safeName(path.basename(file, path.extname(file))), file);
  }
  return map;
}

async function renderOne({ videoPath, name, overlayDataUrl, overlayFilePath, audioClip, settings, outputDir, jobDir, job }) {
  assertNotCancelled(job);
  const id = crypto.randomUUID();
  const clean = safeName(name);
  const duration = await mediaDuration(videoPath, job);
  const overlayPath = overlayFilePath || path.join(jobDir, `${id}_${clean}.png`);
  if (!overlayFilePath) await writeDataUrl(overlayDataUrl, overlayPath);

  const x = Math.max(0, Math.round(asNumber(settings.x, 80)));
  const y = Math.max(0, Math.round(asNumber(settings.y, 80)));
  const width = Math.max(8, Math.round(asNumber(settings.width, 360)));
  const height = Math.max(8, Math.round(asNumber(settings.height, 96)));
  const start = Math.max(0, asNumber(settings.start, 0));
  const end = Math.max(start + 0.05, asNumber(settings.end, duration || 99999));
  const audioStart = Math.max(0, asNumber(settings.audioStart, 0));
  const audioEnd = Math.max(audioStart + 0.05, asNumber(settings.audioEnd, 0));
  const boxColor = colorToFfmpeg(settings.boxColor || "black");
  const boxAlpha = clamp(asNumber(settings.boxAlpha, 0.86), 0, 1);
  const crf = Math.round(clamp(asNumber(settings.crf, 18), 10, 35));
  const outputPath = path.join(outputDir, `${path.basename(videoPath, path.extname(videoPath))}_${clean}.mp4`);
  const enable = `between(t\\,${start}\\,${end})`;

  const args = [
    "-y",
    "-i",
    videoPath,
    "-loop",
    "1",
    "-t",
    String(duration),
    "-i",
    overlayPath,
  ];

  let filterComplex =
    `[0:v]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${boxColor}@${boxAlpha}:t=fill:enable='${enable}'[boxed];` +
    `[1:v]format=rgba[text];[boxed][text]overlay=x=${x}:y=${y}:enable='${enable}':shortest=1[v]`;
  let audioArgs = ["-map", "0:a?", "-c:a", "copy"];

  if (audioClip && audioEnd > audioStart && (await hasAudio(videoPath, job))) {
    const segment = audioEnd - audioStart;
    const delayMs = Math.round(audioStart * 1000);
    args.push("-i", audioClip);
    filterComplex +=
      `;[0:a]volume=enable='between(t\\,${audioStart}\\,${audioEnd})':volume=0[ducked];` +
      `[2:a]aresample=48000,atrim=0:${segment},asetpts=PTS-STARTPTS,apad,atrim=0:${segment},adelay=${delayMs}:all=1[rep];` +
      `[ducked][rep]amix=inputs=2:duration=first:dropout_transition=0[a]`;
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
    "-movflags",
    "+faststart",
    outputPath,
  );

  await runProcess(ffmpegPath(), args, null, job);
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

ipcMain.handle("dialog:output", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择导出文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("render:batch", async (event, payload) => {
  if (activeRenderJob) throw new Error("已有任务正在生成，请先中断或等待完成。");

  const customers = customersFromPayload(payload);
  if (!payload.videoPath) throw new Error("请先选择模板视频。");
  if (!customers.length) throw new Error("请至少输入一个客户姓名。");
  if (!payload.outputDir) throw new Error("请选择导出文件夹。");

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

      let overlayFilePath = null;
      let generatedByAi = false;
      if (payload.ai?.enabled) {
        event.sender.send("render:progress", {
          index,
          total: customers.length,
          name,
          message: `AI 正在生成 ${name} 的手写补丁`,
        });
        overlayFilePath = await aliyunImageEditPatch({
          videoPath: payload.videoPath,
          customer,
          settings: payload.settings,
          ai: payload.ai,
          jobDir,
          job: renderJob,
        });
        generatedByAi = true;
      }

      assertNotCancelled(renderJob);
      const outputPath = await renderOne({
        videoPath: payload.videoPath,
        name,
        overlayDataUrl: payload.overlays?.[customer.id] || payload.overlays?.[name],
        overlayFilePath,
        audioClip,
        settings: payload.settings,
        outputDir,
        jobDir,
        job: renderJob,
      });

      outputs.push({ name, outputPath, audioMatched, generatedByFish, generatedByAi });
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
