#Requires -Version 5.1
<#
.SYNOPSIS
    驱动迅雷「上传到迅雷云盘」界面，把指定文件归档到指定的云盘文件夹。

.DESCRIPTION
    `Thunder.exe -ShellUpload:"<文件>" -StartType=Explorer`（迅雷自己注册的
    资源管理器右键动词「上传到迅雷云盘」）会调起上传界面。**这个界面在两代迅雷
    里完全不同**，本脚本按窗口结构自动判别，两条路径都支持：

    ── 新版（迅雷 25.x / 实测 25.1.20.1645）─────────────────────────────
    弹的是**迅雷主窗口**（标题「迅雷」，类名 Chrome_WidgetWin_0），里面叠一个
    「文件上传」模态框，包含：一个文件图标+文件名行，和底部一行
        [ 上传到 我的云盘 ] [文件夹图标]         [取消]  [确定]
    文件夹图标会再开一个**独立子窗口**「选择云盘位置」（同样是 CEF 自绘），
    里面是文件夹树 + 底部 [新建文件夹] [取消] [确认]。

    所以新版要点两次：
        (a) 点「文件上传」底部那行的文件夹图标 → 打开「选择云盘位置」
        (b) 在「选择云盘位置」里点目标行 → 点「确认」→ 回到「文件上传」
        (c) 点「文件上传」的「确定」→ 真正开始上传
    只有 (c) 才是提交上传；漏掉 (c) 会一直停在那里不动。

    ── 旧版（迅雷 ≤ 24，标题「迅雷云盘弹窗」）───────────────────────────
    单独一个窗口，标题栏下方直接就是文件夹树，底部 [新建文件夹] [取消] [确定]。
    这条路径保留原实现，行为不变。

    两个版本都是 Chromium/CEF 自绘：UI Automation 读不到任何可点的控件
    （实测连 raw 视图也只有一个空 Pane 链），因此只能按**窗口相对坐标**驱动。
    坐标全部按窗口实际矩形换算（相对比例），窗口移动、多显示器、不同 DPI
    都不会失效。

    选目标文件夹有两条路径：
    路径 A（首选，RowIndex >= 0）：直接点选树里已有的那一行。
        调用方先通过迅雷云盘的本地只读接口拿到根目录文件夹顺序，算出目标文件夹
        是第几行，再传进来。树的渲染顺序与接口返回顺序一致，行高固定。
        这条路径全程不输入任何文字，最稳，也不会触发「文件名称不能重复」。

    路径 B（兜底，RowIndex < 0，即目标文件夹还不存在）：新建。
        点「新建文件夹」→ 输入文件夹名 → 回车。
        这条路径要求焦点始终在弹窗上，否则输入框会保留占位文本、回车后建出
        一个叫「新建文件夹」的空目录；因此每次发键前都确认前台窗口。

.OUTPUTS
    一行 JSON：{ ok, status, layout, windowHandle, folder, message }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ZipPath,
    [string]$Folder = 'DSH-Backup',
    [int]$RowIndex = -1,
    [int]$TimeoutSeconds = 180,
    [string]$WindowTitle = '',
    [ValidateSet('auto', 'modern', 'legacy')]
    [string]$Layout = 'auto'
)

$ErrorActionPreference = 'Stop'

# 结果 JSON 里有中文。Windows PowerShell 默认按控制台代码页（GBK）写 stdout，
# 调用方按 UTF-8 读就会变成乱码，所以这里显式把输出编码切成 UTF-8。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# 两代迅雷的窗口标题。
$TITLE_LEGACY = '迅雷云盘弹窗'
$TITLE_MODERN = '迅雷'
$TITLE_PICKER = '选择云盘位置'

# --- Win32 ------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class DshXlWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static IntPtr FindByTitle(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            if (sb.ToString() == title) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string ClassNameOf(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string TitleOf(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // 取拥有该窗口的进程名（不含扩展名），用于确认「这确实是迅雷的窗口」。
    public static string ProcessNameOf(IntPtr hWnd) {
        try {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return "";
            return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        } catch {
            return "";
        }
    }

    // pid 版本：GetWindowThreadProcessId 的 out uint 重载。
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
        System.Threading.Thread.Sleep(40);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // LEFTUP
    }

    public static bool ForceForeground(IntPtr hWnd) {
        ShowWindow(hWnd, 5); // SW_SHOW
        IntPtr fg = GetForegroundWindow();
        uint targetThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        bool attached = false;
        if (fgThread != targetThread) attached = AttachThreadInput(fgThread, targetThread, true);
        bool ok = SetForegroundWindow(hWnd);
        SetFocus(hWnd);
        if (attached) AttachThreadInput(fgThread, targetThread, false);
        return ok;
    }
}
'@

function Emit([hashtable]$Payload) {
    $Payload | ConvertTo-Json -Compress -Depth 5
    exit 0
}

# 拥有迅雷窗口的进程名白名单。
#
# 必须校验进程名，不能只按标题匹配：本插件的调用方是 DeepSeek Harness，而
# 会话窗口标题里常常就带着「迅雷」两个字（例如「迅雷插件更新操作适配 —
# DeepSeek Harness」）。只做 Contains('迅雷') 的模糊匹配会把 DSH 自己的
# 窗口当成迅雷窗口，接着把点击打到 DSH 上——这是实测踩到过的事故。
$THUNDER_PROCESS_NAMES = @('Thunder', 'xllite', 'ThunderPan', 'XLServicePlatform')

function Test-IsThunderWindow {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    $name = [DshXlWin32]::ProcessNameOf($Handle)
    if (-not $name) { return $false }
    return $THUNDER_PROCESS_NAMES -contains $name
}

<#
    按标题找窗口。

    默认要求：标题**完全相同**，且窗口属于迅雷进程。
    -Exact:$false 时退化为「包含」匹配（仅用于旧版标题可能带前后缀的场景），
    但**仍然**强制迅雷进程校验。
#>
function Find-WindowExact {
    param([string]$Title, [switch]$AllowPartial)
    $script:found = [IntPtr]::Zero
    $cb = [DshXlWin32+EnumWindowsProc]{
        param($h, $l)
        if (-not [DshXlWin32]::IsWindowVisible($h)) { return $true }
        if (-not (Test-IsThunderWindow -Handle $h)) { return $true }
        $t = [DshXlWin32]::TitleOf($h)
        if (-not $t) { return $true }
        $hit = if ($AllowPartial) { $t.Contains($Title) } else { $t -eq $Title }
        if ($hit) { $script:found = $h; return $false }
        return $true
    }
    [void][DshXlWin32]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:found
}

function Read-Rect {
    param([IntPtr]$Handle)
    $r = New-Object DshXlWin32+RECT
    if (-not [DshXlWin32]::GetWindowRect($Handle, [ref]$r)) { return $null }
    return $r
}

function Get-WindowBox {
    param([IntPtr]$Handle)
    $r = Read-Rect -Handle $Handle
    if ($null -eq $r) { return $null }
    return @{
        Handle = $Handle
        Left   = $r.Left
        Top    = $r.Top
        Width  = $r.Right - $r.Left
        Height = $r.Bottom - $r.Top
        Rect   = $r
    }
}

<#
    「前台窗口就是我们要操作的那个窗口」判定。

    迅雷给这些 CEF 窗口配了独立的阴影窗（类名 XL_ShadowWindow），有时候成为前台
    窗口的是阴影窗而不是本体，所以不能只比较句柄。

    但也不能只看「同进程 + 中心点相同」：迅雷登录窗正好居中在同一个位置，它的阴影窗
    中心点也相同，那样会在未登录时把登录窗的阴影误判成目标窗，接着把点击打到
    登录窗上。所以这里用**矩形尺寸**判别：阴影窗恰好比本体四周各大 8px。
#>
function Test-WindowForeground {
    param($Box)
    $fg = [DshXlWin32]::GetForegroundWindow()
    if ($fg -eq $Box.Handle) { return $true }
    if ($fg -eq [IntPtr]::Zero) { return $false }

    if ([DshXlWin32]::ClassNameOf($fg) -ne 'XL_ShadowWindow') { return $false }

    $r = Read-Rect -Handle $fg
    if ($null -eq $r) { return $false }
    $wantLeft = $Box.Left - 8
    $wantTop = $Box.Top - 8
    $wantWidth = $Box.Width + 16
    $wantHeight = $Box.Height + 16
    $tol = 6
    return (
        [Math]::Abs($r.Left - $wantLeft) -le $tol -and
        [Math]::Abs($r.Top - $wantTop) -le $tol -and
        [Math]::Abs(($r.Right - $r.Left) - $wantWidth) -le $tol -and
        [Math]::Abs(($r.Bottom - $r.Top) - $wantHeight) -le $tol
    )
}

function Assert-Foreground {
    param($Box, [int]$Attempts = 4)
    for ($i = 0; $i -lt $Attempts; $i++) {
        if (Test-WindowForeground -Box $Box) { return $true }
        [void][DshXlWin32]::ForceForeground($Box.Handle)
        Start-Sleep -Milliseconds 350
    }
    return (Test-WindowForeground -Box $Box)
}

<#
    把窗口抢回前台，直到成功或超时。

    比 Assert-Foreground 更执着：别的程序（组态软件、博途之类）在子窗口关闭的
    瞬间很爱抢前台，一次 350ms 的尝试经常不够。这里最多等 $TimeoutMs 毫秒，
    期间反复 SetForegroundWindow + 校验，抢到了立刻返回。
#>
function Wait-Foreground {
    param($Box, [int]$TimeoutMs = 6000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if (Test-WindowForeground -Box $Box) { return $true }
        [void][DshXlWin32]::ForceForeground($Box.Handle)
        Start-Sleep -Milliseconds 250
    }
    return (Test-WindowForeground -Box $Box)
}

function Stop-FocusLost {
    param($Box, [string]$Where, [string]$LayoutName = '')
    Emit @{
        ok = $false
        status = 'focus-lost'
        layout = $LayoutName
        windowHandle = [int64]$Box.Handle
        message = "$Where 时前台焦点不在目标迅雷窗口上（可能有别的窗口抢焦点，例如登录窗或主界面），为避免误操作已中止"
    }
}

if (-not (Test-Path -LiteralPath $ZipPath)) {
    Emit @{ ok = $false; status = 'missing-file'; message = "找不到要上传的文件：$ZipPath" }
}

# --- 1. 等待窗口出现 ---------------------------------------------------------
# 新版先出「迅雷」主窗口，旧版出「迅雷云盘弹窗」。这里按顺序找，谁先出现用谁。
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$main = [IntPtr]::Zero
$layoutName = $null

while ((Get-Date) -lt $deadline) {
    if ($Layout -in @('auto', 'modern')) {
        $wantTitle = if ($WindowTitle) { $WindowTitle } else { $TITLE_MODERN }
        # 新版主窗口标题就是「迅雷」，要求精确相等，避免匹配到别的程序的窗口标题。
        $main = Find-WindowExact -Title $wantTitle
        if ($main -ne [IntPtr]::Zero) {
            # 「迅雷」主窗口必须真的是主窗口，不要误抓到阴影窗/播放器之类。
            $cls = [DshXlWin32]::ClassNameOf($main)
            if ($cls -in @('Chrome_WidgetWin_0', 'Chrome_WidgetWin_1')) {
                $layoutName = 'modern'
                break
            }
            $main = [IntPtr]::Zero
        }
    }
    if ($Layout -in @('auto', 'legacy')) {
        # 旧版标题偶尔带前后缀，允许包含匹配（进程校验仍然强制）。
        $legacy = Find-WindowExact -Title $TITLE_LEGACY -AllowPartial
        if ($legacy -ne [IntPtr]::Zero) {
            $main = $legacy
            $layoutName = 'legacy'
            break
        }
    }
    Start-Sleep -Milliseconds 400
}

if ($null -eq $layoutName) {
    Emit @{
        ok = $false
        status = 'no-dialog'
        message = "等待 $TimeoutSeconds 秒仍未出现迅雷上传界面（新版「$TITLE_MODERN」/ 旧版「$TITLE_LEGACY」）。请确认迅雷已安装并已登录。"
    }
}

$box = Get-WindowBox -Handle $main
if ($null -eq $box) {
    Emit @{ ok = $false; status = 'rect-failed'; layout = $layoutName; message = '拿不到窗口矩形' }
}
if (-not (Assert-Foreground -Box $box)) { Stop-FocusLost -Box $box -Where '准备操作窗口' -LayoutName $layoutName }
Start-Sleep -Milliseconds 900
$box = Get-WindowBox -Handle $main
if ($null -eq $box) {
    Emit @{ ok = $false; status = 'rect-failed'; layout = $layoutName; message = '拿不到窗口矩形' }
}

# ============================================================================
#  新版：主窗口里的「文件上传」模态框
# ============================================================================
if ($layoutName -eq 'modern') {
    # 「文件上传」模态框在主窗口里是居中的，实测（1120x720 主窗口）：
    #   模态框约 680 宽、466 高，水平居中；底部操作行在模态框高度约 72% 处。
    # 这里全部按主窗口比例算，窗口大小变了也不会失效。
    $dlgLeft = [int]($box.Left + $box.Width * 0.196)
    $dlgTop = [int]($box.Top + $box.Height * 0.176)
    $dlgWidth = [int]($box.Width * 0.607)
    $dlgHeight = [int]($box.Height * 0.647)

    # 底部操作行里的文件夹图标（在「上传到 xxx」后面）。
    $pickerX = [int]($dlgLeft + $dlgWidth * 0.419)
    $actionY = [int]($dlgTop + $dlgHeight * 0.724)
    # 模态框右下的「确定」。
    $confirmX = [int]($dlgLeft + $dlgWidth * 0.938)

    # 先点文件夹图标，打开「选择云盘位置」子窗口。
    if (-not (Wait-Foreground -Box $box -TimeoutMs 6000)) {
        Stop-FocusLost -Box $box -Where '打开「选择云盘位置」' -LayoutName $layoutName
    }
    [DshXlWin32]::ClickAt($pickerX, $actionY)
    Start-Sleep -Milliseconds 1200

    $pickerDeadline = (Get-Date).AddSeconds(20)
    $picker = [IntPtr]::Zero
    while ((Get-Date) -lt $pickerDeadline) {
        $picker = Find-WindowExact -Title $TITLE_PICKER
        if ($picker -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 300
    }
    if ($picker -eq [IntPtr]::Zero) {
        Emit @{
            ok = $false
            status = 'picker-not-found'
            layout = $layoutName
            windowHandle = [int64]$main
            message = '点了「文件上传」里的文件夹图标，但没等到「选择云盘位置」窗口。迅雷界面可能又变了，请手动把备份包拖进云盘文件夹。'
        }
    }

    $pbox = Get-WindowBox -Handle $picker
    if ($null -eq $pbox) {
        Emit @{ ok = $false; status = 'rect-failed'; layout = $layoutName; message = '拿不到「选择云盘位置」窗口矩形' }
    }
    if (-not (Assert-Foreground -Box $pbox)) { Stop-FocusLost -Box $pbox -Where '准备操作「选择云盘位置」' -LayoutName $layoutName }
    Start-Sleep -Milliseconds 800
    $pbox = Get-WindowBox -Handle $picker
    if ($null -eq $pbox) {
        Emit @{ ok = $false; status = 'rect-failed'; layout = $layoutName; message = '拿不到「选择云盘位置」窗口矩形' }
    }

    # 「选择云盘位置」实测（680x466 窗口）：
    #   第 0 行「我的云盘」（根节点，行更高，不参与线性推算）
    #   第 1 行「我的转存」、第 2 行「我的资源」、第 3 行「新建文件夹」、
    #   第 4 行起才是根目录真实文件夹（与旧版相比多了「新建文件夹」这一行）。
    #
    # 行高从第 1 行起才是均匀的，所以以「我的转存」为锚点做线性推算：
    # 实测第 1..6 行中心为 424/464/504/545/585/625，按 40.2px 步长拟合误差 ≤ 0.4px。
    # 目标文件夹永远排在 >= 第 4 行，落在这一段里，因此该锚点可靠。
    $pRow1Ratio = 0.29399
    $pRowPitch = 0.08627
    $pTreeX = [int]($pbox.Left + $pbox.Width * 0.35)
    # 底部按钮行：「新建文件夹」在左，「确认」在右下。
    $pButtonY = [int]($pbox.Top + $pbox.Height * 0.874)
    $pNewFolderX = [int]($pbox.Left + $pbox.Width * 0.114)
    $pConfirmX = [int]($pbox.Left + $pbox.Width * 0.864)

    $maxRow = [int][Math]::Floor(1 + (0.90 - $pRow1Ratio) / $pRowPitch)

    if ($RowIndex -ge 0) {
        if ($RowIndex -gt $maxRow) {
            [DshXlWin32]::ClickAt($pConfirmX, $pButtonY) | Out-Null
            Emit @{
                ok = $false
                status = 'row-out-of-view'
                layout = $layoutName
                folder = $Folder
                rowIndex = $RowIndex
                maxRow = $maxRow
                message = "「$Folder」在「选择云盘位置」里排到第 $RowIndex 行，超出可见范围（最多第 $maxRow 行），无法自动点选。请把它往前挪，或手动把备份包拖进该文件夹。"
            }
        }
        # 以第 1 行为锚点线性推算（第 0 行是更高的根节点，不参与）。
        $rowY = [int]($pbox.Top + $pbox.Height * $pRow1Ratio + $pbox.Height * $pRowPitch * ($RowIndex - 1))
        [DshXlWin32]::ClickAt($pTreeX, $rowY)
        Start-Sleep -Milliseconds 900
        if (-not (Assert-Foreground -Box $pbox)) { Stop-FocusLost -Box $pbox -Where '点选目标文件夹' -LayoutName $layoutName }
        $strategy = "row:$RowIndex"
    }
    else {
        # 目标文件夹还不存在：用左下角的「新建文件夹」。
        [DshXlWin32]::ClickAt($pNewFolderX, $pButtonY)
        Start-Sleep -Milliseconds 900
        if (-not (Assert-Foreground -Box $pbox)) { Stop-FocusLost -Box $pbox -Where '点击新建文件夹' -LayoutName $layoutName }

        $escaped = $Folder -replace '([+^%~()\[\]{}])', '{$1}'
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
        Start-Sleep -Milliseconds 500
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        Start-Sleep -Milliseconds 1500
        $strategy = 'new-folder'
    }

    # 点「确认」回到「文件上传」。
    if (-not (Wait-Foreground -Box $pbox -TimeoutMs 6000)) {
        Stop-FocusLost -Box $pbox -Where '点击确认' -LayoutName $layoutName
    }
    [DshXlWin32]::ClickAt($pConfirmX, $pButtonY)
    Start-Sleep -Milliseconds 1500

    # 「选择云盘位置」应当已经关掉；没关说明点击没生效，此时不能继续点「确定」，
    # 否则可能把文件传到错误的位置。
    if ([DshXlWin32]::IsWindow($picker)) {
        $stillOpenDeadline = (Get-Date).AddSeconds(4)
        while ((Get-Date) -lt $stillOpenDeadline -and [DshXlWin32]::IsWindow($picker)) {
            Start-Sleep -Milliseconds 300
        }
    }
    if ([DshXlWin32]::IsWindow($picker)) {
        Emit @{
            ok = $false
            status = 'picker-not-closed'
            layout = $layoutName
            folder = $Folder
            message = '点了「选择云盘位置」的「确认」但窗口没关掉，无法确认保存路径已设好，已中止（未提交上传）。'
        }
    }

    # 「选择云盘位置」关掉之后，焦点不一定会回到主窗口：实测这台机器上别的程序
    # （McgsPro / 博途之类）经常在这一瞬间把前台抢走。所以这里不是「校验一下就行」，
    # 而是**主动把主窗口抢回前台并重试**；实在抢不回来才中止。
    #
    # 另外主窗口本身可能被移动过（换页/重新布局），所以重新找一次句柄、重读矩形。
    $main = Find-WindowExact -Title $TITLE_MODERN
    if ($main -eq [IntPtr]::Zero) {
        $main = Find-WindowExact -Title $TITLE_MODERN -AllowPartial
    }
    if ($main -eq [IntPtr]::Zero) {
        Emit @{
            ok = $false
            status = 'picker-not-closed'
            layout = $layoutName
            folder = $Folder
            message = '「选择云盘位置」已关闭，但找不到迅雷主窗口了（可能被关掉了）。已中止，未提交上传。'
        }
    }
    $box = Get-WindowBox -Handle $main
    if ($null -eq $box) {
        Emit @{ ok = $false; status = 'rect-failed'; layout = $layoutName; message = '拿不到主窗口矩形' }
    }
    # 主窗口重新定位后按新矩形重算「确定」坐标。
    $dlgLeft = [int]($box.Left + $box.Width * 0.196)
    $dlgTop = [int]($box.Top + $box.Height * 0.176)
    $dlgWidth = [int]($box.Width * 0.607)
    $dlgHeight = [int]($box.Height * 0.647)
    $confirmX = [int]($dlgLeft + $dlgWidth * 0.938)
    $actionY = [int]($dlgTop + $dlgHeight * 0.724)

    if (-not (Wait-Foreground -Box $box -TimeoutMs 8000)) {
        Stop-FocusLost -Box $box -Where '点击确定' -LayoutName $layoutName
    }

    [DshXlWin32]::ClickAt($confirmX, $actionY)
    Start-Sleep -Milliseconds 1500

    Emit @{
        ok = $true
        status = 'submitted'
        layout = $layoutName
        windowHandle = [int64]$main
        folder = $Folder
        strategy = $strategy
        rowIndex = $RowIndex
        pickerWindow = [int64]$picker
        message = "已在新版迅雷界面把上传目标设为「$Folder」（$strategy）并提交"
    }
}

# ============================================================================
#  旧版：「迅雷云盘弹窗」单窗口
# ============================================================================
$left = $box.Left
$top = $box.Top
$width = $box.Width
$height = $box.Height

# 实测（450x316 的弹窗）：根节点行中心在窗口高度 13.924% 处，行高占 12.025%。
# 行号：0 = 我的云盘，1 = 我的转存，2 = 我的资源，3 起 = 真实文件夹。
$rowTopRatio = 0.13924
$rowPitchRatio = 0.12025
$maxRow = [int][Math]::Floor((0.93 - $rowTopRatio) / $rowPitchRatio)
$treeX = [int]($left + $width * 0.33)
$buttonY = [int]($top + $height * 0.924)
$newFolderX = [int]($left + $width * 0.144)
$confirmX = [int]($left + $width * 0.642)

# --- 选择目标文件夹 ---------------------------------------------------------
if ($RowIndex -ge 0) {
    if ($RowIndex -gt $maxRow) {
        Emit @{
            ok = $false
            status = 'row-out-of-view'
            layout = $layoutName
            folder = $Folder
            rowIndex = $RowIndex
            maxRow = $maxRow
            message = "「$Folder」在弹窗文件夹树里排到第 $RowIndex 行，超出可见范围（最多第 $maxRow 行），无法自动点选。请把它往前挪，或手动把备份包拖进该文件夹。"
        }
    }
    # 路径 A：直接点选已有文件夹，全程不输入文字。
    $rowY = [int]($top + $height * $rowTopRatio + $height * $rowPitchRatio * $RowIndex)
    [DshXlWin32]::ClickAt($treeX, $rowY)
    Start-Sleep -Milliseconds 900
    if (-not (Assert-Foreground -Box $box)) { Stop-FocusLost -Box $box -Where '点选目标文件夹' -LayoutName $layoutName }
    $strategy = "row:$RowIndex"
}
else {
    # 路径 B：目标文件夹还不存在，用「新建文件夹」创建。
    [DshXlWin32]::ClickAt($newFolderX, $buttonY)
    Start-Sleep -Milliseconds 800
    if (-not (Assert-Foreground -Box $box)) { Stop-FocusLost -Box $box -Where '点击新建文件夹' -LayoutName $layoutName }

    $escaped = $Folder -replace '([+^%~()\[\]{}])', '{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 1500
    $strategy = 'new-folder'
}

# --- 确定 -------------------------------------------------------------------
if (-not [DshXlWin32]::IsWindow($main)) {
    Emit @{ ok = $true; status = 'dialog-closed-early'; layout = $layoutName; folder = $Folder; message = '弹窗在点击确定前已关闭' }
}
if (-not (Assert-Foreground -Box $box)) { Stop-FocusLost -Box $box -Where '点击确定' -LayoutName $layoutName }

[DshXlWin32]::ClickAt($confirmX, $buttonY)
Start-Sleep -Milliseconds 1500

Emit @{
    ok = $true
    status = 'submitted'
    layout = $layoutName
    windowHandle = [int64]$main
    folder = $Folder
    strategy = $strategy
    rowIndex = $RowIndex
    message = "已把上传目标设为「$Folder」（$strategy）并点击确定"
}
