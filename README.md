# 视频姓名批量替换桌面版

这个版本用于打包后发给别人使用。每个使用者在自己的电脑上填写 Fish Audio API Key 和音色 `reference_id`，软件不内置你的 Key。

## 开发运行

```bash
npm install
npm start
```

## 打包

```bash
npm run dist
```

当前默认会生成 macOS zip。Windows 包建议在 Windows 机器或 GitHub Actions 的 Windows 环境里打：

```bash
npm run dist -- --win
```

如果本机缓存目录没有权限，可以把缓存放到项目目录：

```bash
export ELECTRON_CACHE="$PWD/.electron-cache"
export electron_config_cache="$PWD/.electron-cache"
export ELECTRON_BUILDER_CACHE="$PWD/.electron-builder-cache"
npm run dist
```

## 使用方式

- 选择模板视频。
- 选择导出文件夹。
- 输入客户信息，一行一个：`姓名，生日，日期，道长`。
- 设置视频画面中文字区域。
- 设置音频短句的开始秒和结束秒。
- 填 Fish Audio API Key、音色 `reference_id`。默认句子模板会把客户姓名、道长名和生日填进去。
- 可选开启 AI 手写增强，填写阿里云百炼 API Key，用 Qwen-Image-Edit 生成更自然的黄纸手写补丁。
- 开始批量生成。

客户信息示例：

```text
王杰，1998年7月21日，2026年5月12号，天一
李四，19970525，2026年5月12号，天一道长
```

可用模板字段：`{name}`、`{date}`、`{birthdayText}`、`{birthdayDigits}`、`{masterName}`。

Fish API Key 和百炼 API Key 会保存在用户自己电脑的应用数据目录里。

打包后的应用会带上 FFmpeg 和 FFprobe，使用者不需要单独安装。
