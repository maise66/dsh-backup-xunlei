# dsh-backup-xunlei · 一键把 DSH 插件与技能备份到迅雷网盘

在 DeepSeek Harness 的「设置」里增加一页 **备份与迅雷网盘**，点一下按钮就把
这台机器的 DSH 插件和技能打包成一个自解释的 ZIP，并上传到迅雷网盘的归档
文件夹（默认 `DSH-Backup`）。换机器时解压备份包、运行里面的 `restore.ps1`
即可还原。

## 三个入口，同一套实现

| 入口 | 用法 |
|---|---|
| 设置面板 | 设置 → 备份与迅雷网盘 → 「一键备份并上传」 |
| 斜杠命令 | `/backup-xunlei`、`/backup-xunlei --no-upload`、`/backup-xunlei --force` |
| Agent 工具 | `backup_xunlei`（参数 `upload`、`force`） |

## 安装

插件通过 profile 的 `link:` 依赖挂载，已经在用的这台机器上装好了；换机器时备份包里的
`restore.ps1` 会把它接回去。手工安装就是三步：

```powershell
# 1. profile 的 package.json 里加依赖
#    "dsh-backup-xunlei": "link:<本插件绝对路径>"
# 2. 把 "dsh-backup-xunlei" 加进 dsh.profile.bundles
# 3. 装依赖并重启 DeepSeek Harness
pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>"
```

**必须重启 DSH**：profile 的 `bundles` 列表在启动时读取，热重载不会加载新的 bundle。
技能是热生效的，插件不是。

自检（不需要启动 DSH）：

```powershell
node test/smoke.mjs            # 注册与渲染检查
node test/smoke.mjs --upload   # 额外真跑一次打包 + 上传
powershell -File tools/ensure-bom.ps1 -Check   # 检查脚本是否仍是 UTF-8 BOM
```

> `lib/xunlei-upload.ps1` 里全是中文注释与中文提示，**必须是 UTF-8 with BOM**：
> Windows PowerShell 5.1 在没有 BOM 时会按 ANSI 代码页解释源码，中文被拆成无效
> 字节序列、脚本直接解析失败。编辑器/写入工具常会写成不带 BOM 的 UTF-8，所以
> 改完这个脚本务必跑一次 `tools/ensure-bom.ps1`（`npm run fix:bom` 同义）。


## 换机还原：双击一下

1. 解压备份包到任意目录
2. 双击 **`一键安装.cmd`**
3. 启动 DeepSeek Harness

`restore.ps1` 会做完四件事：

| 步骤 | 说明 |
|---|---|
| 技能 | 复制到 `<DSH_HOME>/skills`（DSH 只扫描根目录下一层，位置必须准确） |
| 插件源码 | 复制到 `<DSH_HOME>/restored-plugins/<包名>` |
| profile | 与目标机已有的 `package.json` 合并：依赖与 bundle 取**并集**，不覆盖已有内容；被覆盖的配置文件留成 `.bak-时间戳` |
| 依赖 | 有 pnpm 就 `pnpm install`；**没有 pnpm 就用 NTFS 目录联接把 12 个无依赖插件直接接上** |

几个刻意的设计：

- **自动识别 profile**：优先用备份里的名字，其次目标机唯一存在的 profile，再次最近修改的那个；这台机器从没启动过 DSH 时，直接按备份包创建 profile。
- **能离线就离线**：12/14 个插件没有第三方依赖，改写成本机 `link:` 后不需要联网；只有 `dsh-context`（zod）与 `dshmarket`（js-yaml、undici）保留 npm 规格，`pnpm install` 只下这几个小包。
- **批处理文件全 ASCII**：cmd.exe 按当前代码页解释批处理，里面写中文在非中文区域设置下必然乱码，所以中文提示全部交给带 BOM 的 `restore.ps1` 打印；`一键安装.cmd` 只是转发到 `install.cmd`，即使解压工具弄乱中文名也还有可用入口。

命令行等价写法：

```powershell
powershell -ExecutionPolicy Bypass -File restore.ps1 -Install
```

## 备份包里有什么

```
一键安装.cmd / install.cmd   双击这个就装好了（转发到 restore.ps1 -Install）
restore.ps1     还原脚本本体（可单独带参数运行）
manifest.json   机器可读清单：每个插件/技能的版本、来源 spec、内容指纹、体积
README.md       随本次内容生成的人读还原说明
profile/        package.json、cordis.patch.yml、cordis.yml、pnpm-lock.yaml
plugins/        第三方插件的完整源码
skills/         ~/.dsh/skills 的全部内容
```

「新的插件和技能」是这样定义的：每次上传成功后把当时的插件/技能内容指纹写进
`$DSH_HOME/backup-xunlei/state.json`；下次运行先盘点再比对，明确列出新增了
哪些、哪些有改动，界面和工具都会显示这份差异。

## 上传是怎么做的

迅雷自己注册了一个资源管理器右键动词「上传到迅雷云盘」，对应命令行：

```
Thunder.exe -ShellUpload:"<文件>" -StartType=Explorer
```

**这个界面在两代迅雷里完全不同**，本插件两条路径都支持，脚本按窗口标题自动判别。

### 新版（迅雷 25.x，实测 25.1.20.1645）

弹的是**迅雷主窗口**（标题「迅雷」），里面叠一个「文件上传」模态框：

```
┌ 文件上传 ────────────────────────────── ✕ ┐
│  [图标]  dsh-backup-YYYYMMDD-HHMMSS.zip      │
│                                              │
│  [ 上传到 我的云盘 ] [📁]     [取消] [确定]   │
└──────────────────────────────────────────────┘
```

流程要点两次：

1. 点底部那行的**文件夹图标** → 弹出**独立子窗口「选择云盘位置」**
   （文件夹树 + 底部 `[新建文件夹] [取消] [确认]`）
2. 在树里点目标文件夹 → 点「**确认**」→ 回到「文件上传」，
   路径变成 `我的云盘\DSH-Backup`
3. 点「**确定**」→ 这才真正开始上传

漏掉第 3 步不会报错，只是**一直不传**，所以脚本把它当成必须成功的一步。

### 旧版（迅雷 ≤ 24）

单独一个窗口「迅雷云盘弹窗」，标题栏下方直接就是文件夹树，
底部 `[新建文件夹] [取消] [确定]`，点选 + 确定即可。这条路径保留原实现。

### 两版共同的处理

- **都读不到 UI Automation**：两代都是 Chromium/CEF 自绘窗口，UIA 连 raw 视图也只
  有一个空 Pane 链，所以只能按**窗口相对坐标**驱动（按窗口实际矩形换算，窗口移动、
  多显示器、不同 DPI 都不会失效）。
- **首选直接点选已有文件夹**：先通过本地接口拿到云盘根目录文件夹顺序，算出目标文件夹
  是树里第几行再去点，全程不输入任何文字。行号偏移两版只差 1（新版树里多一个
  「新建文件夹」固定节点），且新版行高从第 1 行起才均匀（第 0 行「我的云盘」是更高的
  根节点），所以脚本以第 1 行为锚点做线性推算——实测第 1–6 行误差 ≤ 0.4px。
- **兜底新建**：目标文件夹不存在时点「新建文件夹」→ 输入名字 → 回车。迅雷同级重名会
  提示「文件名称不能重复」，所以这条路径只在目录确实不存在时才用。
- **只认迅雷自己的窗口**：必须同时满足「标题精确相等」+「窗口属于 Thunder / xllite
  进程」才认。这条是实测事故换来的：DSH 会话窗口标题里常常就带「迅雷」两个字
  （例如「迅雷插件更新操作适配 — DeepSeek Harness」），只按标题模糊匹配会把点击
  打到 DSH 自己窗口上。
- 上传前先确认迅雷账号在线（否则直接中止、不碰界面），每次发键前校验前台焦点确实是
  目标窗口——迅雷给这些窗口配了独立的阴影窗（`XL_ShadowWindow`），登录窗又出现在
  同一个居中位置，判定必须看窗口矩形尺寸才能区分。实测教训：会话过期时登录窗会抢走
  焦点，未经校验的按键会落到登录窗上并在云盘根目录建出一个叫「新建文件夹」的空目录。
- 「选择云盘位置」点完「确认」若没关掉，脚本判定保存路径没设好并**中止**，不会再去点
  「确定」——否则可能把文件传到错误的位置。

上传完成后，插件通过迅雷云盘客户端的**本地只读接口**（`pan-cli` / `xllite`
监听 `127.0.0.1`，页面里注入的 `uiauth` 令牌 + `pan-auth` 头）列出目标文件夹，
确认文件真的落到了 `DSH-Backup` 里；确认不了就如实报告「已提交，未确认」，
不会假装成功。

> 端口会随版本变：实测迅雷 25.1.20 用 **10581**（旧版曾在 10574 / 21603）。
> 候选端口列表已更新，并保留「枚举所有本地监听端口」的兜底。


## 配置

在 profile 的 `cordis.patch.yml` 里按 `id: backup-xunlei` 覆盖（`config` 整体替换）：

```yaml
- id: backup-xunlei
  name: 'dsh-backup-xunlei'
  config:
    enabled: true
    cloudFolder: DSH-Backup
    includePlugins: true
    includeSkills: true
    keepArchives: 5
```

## 注意

- 上传时会短暂占用前台鼠标（新版要自动点两次：选文件夹的「确认」+ 主界面的
  「确定」），这几秒请不要操作鼠标，也别让别的窗口抢焦点（会直接中止而不是乱点）。
- 读不到本地云盘接口时，上传仍然会进行，只是无法自动确认落点。
- 本机保留最近 `keepArchives` 个备份包于 `$DSH_HOME/backup-xunlei/out`。
- 不含 `@deepseek-ai/*` 内置 bundle —— 那些随 DSH 发行，不需要备份。
