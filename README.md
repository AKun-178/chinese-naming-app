# 视频姓名批量替换桌面版

这个版本用于打包后发给别人使用。每个使用者在自己的电脑上填写 Fish Audio API Key，也可以上传已授权的人声音频，让软件创建私有 Fish 音色并自动回填 `reference_id`。软件不内置你的 Key。

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
- 确认黄纸区域位置，默认已套用当前模板视频的位置；黄纸出现秒/结束秒按最终完整视频时间轴计算，默认 `0` 到 `65` 秒。
- 设置音频短句的开始秒；结束秒填 `0` 时会按生成语音长度自动替换。
- 软件已内置默认纯背景声，也可以选择一条新的分离背景音乐。生成时会丢掉原视频音频，用背景音乐加 AI 人声重新合成。
- 可点软件里的“获取 Fish API”和“获取百炼 API”快速打开对应控制台。
- 填 Fish Audio API Key。如果已有音色，直接填音色 `reference_id`；如果没有，点“上传音频并克隆音色”，选择 10 秒以上清晰人声音频，成功后软件会自动填入并保存音色 ID。
- 默认句子模板会把客户姓名、道长名和生日填进去。
- 如果有固定后半段，可以选择“不生成，直接拼接已做好的后段视频”，软件会在批量时直接拼接；也可以选择“生成一次后段音色并复用”，再选择后段画面、纯背景和固定文案生成缓存后段。
- 填写阿里云百炼 API Key，用 Qwen-Image-Edit 模仿原图手写并替换黄纸三行字。
- 开始批量生成；生成中可点“中断生成”停止当前任务。

客户信息示例：

```text
王杰，1998年7月21日，2026年5月12号，天一
李四，19970525，2026年5月12号，天一道长
```

可用模板字段：`{name}`、`{date}`、`{birthdayText}`、`{birthdayDigits}`、`{masterName}`。

Fish API Key 和百炼 API Key 会保存在用户自己电脑的应用数据目录里。

打包后的应用会带上 FFmpeg 和 FFprobe，使用者不需要单独安装。
