# KALPA Auto Play (Frida)

一个针对 Android 版 KALPA 的 Frida AutoMode 研究 Hook。

它不会读取或保存点击谱，也不做屏幕图像识别。脚本在谱面播放期间临时开启游戏内部的 AutoMode，并提供一个可自由拖动的 Android 原生悬浮按钮。

> 当前仅验证 **KALPA 4.0.7 / arm64-v8a**。脚本包含原生指令签名检查；遇到未知版本时会拒绝安装 Hook，而不是盲目写内存。

## 功能

- 点击悬浮球切换 `AUTO OFF / ON`；
- 长按拖动后停留在松手位置，不吸附、不收缩、不自动隐藏；
- 通过真实 `FrameLayout.LayoutParams` 移动，避免 Unity `SurfaceView` 对大幅视觉平移的错误裁切；
- 四周保留约 6dp 安全边距，防止按钮被拖出渲染区域；
- 只在谱面实际播放期间临时修改 AutoMode 字段，离开回调前恢复原值。

## 工作原理

脚本等待 `libunity.so` 与 `libil2cpp.so` 完成加载，然后 Hook KALPA 4.0.7 中负责谱面更新的 native 方法。开启悬浮球开关后，每次回调只在有效播放状态下临时设置 panel 与 logic 的 AutoMode 字段，并在回调返回时恢复。

因此它是针对游戏内部运行时状态的 Hook，不是通用的谱面解析器，也没有单独维护歌曲点击数据。

## 仓库不包含的内容

本仓库有意不提供：

- KALPA APK、拆包文件、资源、截图或原生库；
- 修改后的 APK 或可直接安装的整包；
- Frida Gadget / Frida Server 二进制；
- 任何账号数据或游戏服务接口实现。

请从合法渠道安装游戏，并从 [Frida 官方发布页](https://github.com/frida/frida/releases) 自行取得所需工具。

## 构建

参考验证环境：

- Python `frida 17.15.3`
- `frida-tools 14.10.4`
- Node.js 18 或更高版本
- `frida-java-bridge 7.0.13`（由 npm lockfile 固定）

安装依赖并编译：

```bash
python -m pip install "frida==17.15.3" "frida-tools==14.10.4"
npm ci
npm run build
```

输出文件为：

```text
dist/kalpa_overlay_agent.bundle.js
```

## 加载方式

使用已连接的 Android 设备与 Frida Server：

```bash
frida -U -f com.quesera.kalpa -l dist/kalpa_overlay_agent.bundle.js
```

如果使用 Frida Gadget，可参考 [`examples/gadget.config.json`](examples/gadget.config.json)，将配置文件、你自行取得的 Gadget 和编译后的 bundle 放到 Gadget 能读取的位置。Gadget 配置文件名需要与实际 Gadget 库名相匹配，具体规则请参考 Frida 官方文档。

游戏启动后：

1. 灰色圆球表示 `AUTO OFF`，绿色表示 `AUTO ON`；
2. 点击圆球切换开关；
3. 按住圆球拖动可自由调整位置；
4. 正常选曲并点击 PLAY。

## 兼容性与风险

- 偏移和字段布局仅适用于 KALPA 4.0.7 arm64；游戏更新后需要重新分析，不能直接修改版本号继续使用。
- Root、注入或自动游玩可能违反游戏服务条款并影响排行榜公平性。建议只用于本地研究、可控测试和无竞争场景；账号与设备风险由使用者自行承担。
- 本项目按 MIT License 原样提供，不保证适用于任何设备、系统版本或未来游戏版本。

## English summary

This repository contains source code for a Frida-based AutoMode research hook verified on **KALPA 4.0.7 for Android arm64-v8a**. It toggles the game's internal AutoMode during active chart playback and exposes a freely draggable native Android button. It does not contain the game, extracted game assets, modified APKs, Frida binaries, or song charts.

## License

[MIT](LICENSE)
