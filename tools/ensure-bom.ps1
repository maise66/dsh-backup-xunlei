# 给 dsh-backup-xunlei 的 PowerShell 脚本补回 UTF-8 BOM。
#
# 背景：lib/xunlei-upload.ps1 里有大量中文注释和中文提示。Windows PowerShell 5.1
# 在没有 BOM 时会按当前 ANSI 代码页（中文系统上是 GBK）解释脚本源码，中文被拆成
# 无效字节序列 → 解析直接失败。所以这个文件**必须是 UTF-8 with BOM**。
#
# 编辑器/工具（包括本仓库用到的写入工具）常常写成不带 BOM 的 UTF-8，因此每次改完
# 这个脚本都跑一下本脚本，再交给测试。
#
# 用法：
#   pwsh -File tools/ensure-bom.ps1          # 检查并修复
#   pwsh -File tools/ensure-bom.ps1 -Check   # 只检查，非 0 退出表示缺 BOM

[CmdletBinding()]
param(
    [switch]$Check,
    [string[]]$Paths = @('lib/xunlei-upload.ps1')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$utf8Bom = [System.Text.UTF8Encoding]::new($true)
$bad = 0

foreach ($rel in $Paths) {
    $path = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "  MISSING  $rel"
        $bad++
        continue
    }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if ($hasBom) {
        Write-Host "  OK       $rel (UTF-8 BOM)"
        continue
    }
    if ($Check) {
        Write-Host "  NO-BOM   $rel"
        $bad++
        continue
    }
    # 内容本身是 UTF-8，只是缺 BOM；补上即可，不要重新编码内容。
    $text = [System.IO.File]::ReadAllText($path, $utf8NoBom)
    [System.IO.File]::WriteAllText($path, $text, $utf8Bom)
    Write-Host "  FIXED    $rel (BOM 已补上)"
}

if ($bad -gt 0) {
    Write-Host "有 $bad 个文件缺少 BOM ❌"
    exit 1
}
Write-Host '全部为 UTF-8 BOM ✅'
exit 0
