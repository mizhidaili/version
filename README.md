# Version

[English](#english) | [简体中文](#简体中文)

> Let one topic hold multiple parallel texts that can coexist, evolve, and remain editable over time.

## English

### What is Version?

Version is an Obsidian plugin for managing a collection of ideas with less friction. It brings multiple files together and presents them as one note in the File Explorer. When the note is opened, controls at the right edge let you switch between its versions.

Unlike Git or historical snapshots, every version managed by Version is an independent, ordinary vault file. It can be edited or linked at any time. Disabling or uninstalling the plugin does not change the contents of those files.

### Why Version?

New understanding often grows from putting an idea into practice. That new understanding is not necessarily better than the earlier one in every way, so the earlier expression may still be worth keeping.

Keeping several layers of notes about the same topic—experience gained through practice, the first intuition, and later ways of expressing it—makes it possible to see the idea more completely. It can also give AI tools a broader view when the user chooses to let them read several versions. Version makes these evolving ideas easier to manage without flattening them into a single “final” text.

### Features

- Switch between several versions in the same workspace leaf.
- Keep every version editable.
- Show a healthy series as one topic in the File Explorer.
- Add, remove, and rearrange relationships in a staged version manager.
- Link to the whole topic or to one exact version.
- Aggregate backlinks from every resolvable version in a topic.
- Work with Markdown, Canvas, and Excalidraw files.
- Use the interface in English, Simplified Chinese, Danish, or Japanese.

### Data ownership and safety

Version never stores note contents in a private database. Every version remains a real, independent file in the vault. If Version is disabled or uninstalled, the files remain readable by Obsidian and other compatible software; only the aggregation interface disappears.

Series membership is recorded explicitly outside note bodies. Version does not infer relationships from filenames, insert machine metadata into Markdown, or rewrite note contents. If a relationship cannot be resolved safely, the plugin fails open and keeps the affected files visible for repair.

Version runs locally. It does not upload vault contents, collect telemetry, or require an account.

### Basic use

1. Open an ordinary supported file.
2. Choose **Create versions for this note…**.
3. Add an existing file or create an empty version in the version manager.
4. Select **Done** to save the staged relationship.
5. Use the version tabs at the right edge to switch versions.

V1 represents a healthy series in the File Explorer, but it is not more correct, more final, or less editable than another version.

### Installation

After Version is accepted into the Obsidian Community Plugins directory, install it from **Settings → Community plugins**.

For manual installation, place these files in `<your-vault>/.obsidian/plugins/version/` and enable **Version**:

- `main.js`
- `manifest.json`
- `styles.css`

### Compatibility

- Minimum Obsidian version: **1.13.4**
- Physically tested: **macOS** and **iPadOS**
- Not yet physically tested: **Windows**, **Linux**, and **Android**

Version is not marked as desktop-only. Desktop-only file actions are hidden or safely degraded on mobile.

### Privacy

Version makes no network requests, uploads no vault content, and collects no telemetry.

### License

Version is released under the [MIT License](LICENSE).

---

## 简体中文

> 让同一个主题容纳多个可以长期并存、自由编辑的平行文本。

### Version 是什么

Version 是为了更简洁地管理 Obsidian 中的思想库而制作的插件。在功能上，它可以将多篇文件集成，在文件列表中显示为一篇。打开后，文字显示界面右侧会出现用于选择和切换版本的按键。

不同于 Git 或历史快照，由 Version 管理的主题的每一个版本，本质上都是一篇单独的仓库文件，可以随时修改或引用。即使停用或卸载插件，也不会影响这些文件的内容。

### 为什么制作 Version

对于某种思想，产生后经过实践，往往会有新的认识。新的认识并不一定在方方面面都优于旧的认识，故而有持续保留旧版本的必要。

对于同一主题的思想，层层叠叠地保留笔记——经过实践得到的经验、最初的直觉、后来的表达……可以让人更完整地看见自己的想法。在用户主动选择让 AI 读取多个版本时，也可以使其更全面地把握这些想法。Version 可以使经常迭代的思想变得易于管理，而不必把它们压缩成一篇所谓的“最终文本”。

### 主要功能

- 在同一个工作区标签中切换多个版本。
- 所有版本都可以继续编辑。
- 在文件列表中将健康的版本系列显示为一个主题。
- 通过暂存式版本管理界面添加、移除和调整版本关系。
- 链接可以指向整个主题或某个具体版本。
- 汇总同一主题所有可解析版本的反向链接。
- 支持 Markdown、Canvas 和 Excalidraw 文件。
- 支持英语、简体中文、丹麦语和日语界面。

### 数据所有权与安全

Version 不会把笔记正文储存在私有数据库中。每个版本都是仓库中真实、独立的文件。即使插件被停用或卸载，所有文件仍然可以被 Obsidian 和其他兼容软件正常读取；消失的只是聚合界面。

版本关系明确登记在正文之外。Version 不会根据文件名猜测关系，不会向 Markdown 插入机器元数据，也不会改写笔记正文。如果某个关系无法被安全解析，插件会优先恢复文件的可见性，等待用户修复。

Version 完全在本地运行，不上传仓库内容，不收集遥测，也不要求注册账号。

### 基本使用方法

1. 打开一篇普通的受支持文件。
2. 选择“为这篇笔记创建版本…”。
3. 在版本管理界面接纳已有文件，或创建一个空白版本。
4. 点击“完成”，保存暂存的版本关系。
5. 使用编辑区右缘的版本页签切换不同版本。

V1 是健康系列在文件列表中的代表，但它并不比其他版本更正确、更正式，也同样可以继续编辑。

### 安装

Version 被 Obsidian 社区插件目录收录后，可以前往“设置 → 第三方插件”搜索并安装。

手动安装时，请把以下文件放入 `<你的仓库>/.obsidian/plugins/version/`，然后启用 **Version**：

- `main.js`
- `manifest.json`
- `styles.css`

### 兼容性

- 最低 Obsidian 版本：**1.13.4**
- 已进行实体设备测试：**macOS**、**iPadOS**
- 尚未进行实体设备测试：**Windows**、**Linux**、**Android**

Version 没有被标记为仅限桌面端。只能在桌面端使用的文件操作会在移动端隐藏或安全降级。

### 隐私

Version 不发起网络请求，不上传仓库内容，也不收集遥测数据。

### 许可证

Version 使用 [MIT License](LICENSE) 发布。
