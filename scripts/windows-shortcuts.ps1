[CmdletBinding()]
param(
  [ValidateSet('Install', 'Uninstall')]
  [string]$Action = 'Install',

  [string]$RepositoryRoot,

  [string]$DesktopDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::DesktopDirectory
  ),

  [string]$ProgramsDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Programs
  ),

  [string]$SupportDirectory = (Join-Path -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) -ChildPath 'Agent Universe Lite')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

function ConvertTo-CanonicalPath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Label resolved to an empty path."
  }
  try {
    return [IO.Path]::GetFullPath($Value)
  } catch {
    throw "$Label is not a valid path: $Value"
  }
}

function Get-MissingDirectoryChain {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $missing = [System.Collections.Generic.List[string]]::new()
  $cursor = $Directory
  while (-not (Test-Path -LiteralPath $cursor)) {
    [void]$missing.Add($cursor)
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) {
      throw "$Label has no existing parent directory: $Directory"
    }
    $cursor = $parent.FullName
  }
  if (-not (Test-Path -LiteralPath $cursor -PathType Container)) {
    throw "$Label conflicts with an existing file: $cursor"
  }
  return $missing.ToArray()
}

function Assert-OwnedFileDestination {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ((Test-Path -LiteralPath $File) -and
      -not (Test-Path -LiteralPath $File -PathType Leaf)) {
    throw "$Label conflicts with a non-file path: $File"
  }
}

function New-AgentUniverseIcon {
  param([Parameter(Mandatory = $true)][string]$IconPath)

  Add-Type -AssemblyName System.Drawing
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $frames = [System.Collections.Generic.List[object]]::new()

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new(
      $size,
      $size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = $null
    $orbitCyan = $null
    $orbitGold = $null
    $glow = $null
    $core = $null
    $star = $null
    $png = $null
    try {
      $scale = $size / 64.0
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)

      $background = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::FromArgb(255, 8, 13, 27)
      )
      $graphics.FillEllipse(
        $background,
        [System.Drawing.RectangleF]::new(
          [single](2 * $scale), [single](2 * $scale),
          [single](60 * $scale), [single](60 * $scale)
        )
      )

      $orbitWidth = [single][Math]::Max(1.0, 1.7 * $scale)
      $orbitCyan = [System.Drawing.Pen]::new(
        [System.Drawing.Color]::FromArgb(235, 95, 221, 255), $orbitWidth
      )
      $orbitGold = [System.Drawing.Pen]::new(
        [System.Drawing.Color]::FromArgb(220, 255, 190, 72), $orbitWidth
      )
      $graphics.TranslateTransform([single]($size / 2.0), [single]($size / 2.0))
      $graphics.RotateTransform([single]-24)
      $graphics.DrawEllipse(
        $orbitCyan,
        [System.Drawing.RectangleF]::new(
          [single](-25 * $scale), [single](-10 * $scale),
          [single](50 * $scale), [single](20 * $scale)
        )
      )
      $graphics.RotateTransform([single]48)
      $graphics.DrawEllipse(
        $orbitGold,
        [System.Drawing.RectangleF]::new(
          [single](-22 * $scale), [single](-8 * $scale),
          [single](44 * $scale), [single](16 * $scale)
        )
      )
      $graphics.ResetTransform()

      $glow = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::FromArgb(155, 126, 91, 239)
      )
      $core = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::FromArgb(255, 235, 224, 255)
      )
      $graphics.FillEllipse(
        $glow,
        [System.Drawing.RectangleF]::new(
          [single](23 * $scale), [single](23 * $scale),
          [single](18 * $scale), [single](18 * $scale)
        )
      )
      $graphics.FillEllipse(
        $core,
        [System.Drawing.RectangleF]::new(
          [single](27 * $scale), [single](27 * $scale),
          [single](10 * $scale), [single](10 * $scale)
        )
      )

      $star = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::FromArgb(255, 255, 206, 91)
      )
      foreach ($point in @(@(14, 17, 3), @(47, 13, 2), @(49, 45, 3))) {
        $graphics.FillEllipse(
          $star,
          [System.Drawing.RectangleF]::new(
            [single]($point[0] * $scale), [single]($point[1] * $scale),
            [single][Math]::Max(1.0, $point[2] * $scale),
            [single][Math]::Max(1.0, $point[2] * $scale)
          )
        )
      }

      $png = [IO.MemoryStream]::new()
      $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
      [void]$frames.Add($png.ToArray())
    } finally {
      if ($null -ne $png) { $png.Dispose() }
      if ($null -ne $star) { $star.Dispose() }
      if ($null -ne $core) { $core.Dispose() }
      if ($null -ne $glow) { $glow.Dispose() }
      if ($null -ne $orbitGold) { $orbitGold.Dispose() }
      if ($null -ne $orbitCyan) { $orbitCyan.Dispose() }
      if ($null -ne $background) { $background.Dispose() }
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  $temporaryIcon = Join-Path -Path (Split-Path -Parent $IconPath) -ChildPath (
    '.agent-universe-lite-' + [Guid]::NewGuid().ToString('N') + '.ico'
  )
  try {
    $stream = [IO.File]::Open(
      $temporaryIcon,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $writer = [IO.BinaryWriter]::new($stream)
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$sizes.Count)
      $offset = 6 + (16 * $sizes.Count)

      for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { [byte]0 } else { [byte]$sizes[$index] }
        $frame = [byte[]]$frames[$index]
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$frame.Length)
        $writer.Write([UInt32]$offset)
        $offset += $frame.Length
      }
      foreach ($frameObject in $frames) {
        $writer.Write([byte[]]$frameObject)
      }
    } finally {
      $writer.Dispose()
      $stream.Dispose()
    }

    $loaded = [System.Drawing.Icon]::new($temporaryIcon)
    try {
      if ($loaded.Width -lt 16 -or $loaded.Height -lt 16) {
        throw 'Generated icon could not be loaded at a usable size.'
      }
    } finally {
      $loaded.Dispose()
    }
    Move-Item -LiteralPath $temporaryIcon -Destination $IconPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryIcon -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryIcon -Force
    }
  }
}

function Set-AgentUniverseShortcut {
  param(
    [Parameter(Mandatory = $true)]$Shell,
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$ElectronPath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$IconPath
  )

  $temporaryShortcut = Join-Path -Path (Split-Path -Parent $ShortcutPath) -ChildPath (
    '.agent-universe-lite-' + [Guid]::NewGuid().ToString('N') + '.lnk'
  )
  $shortcut = $null
  try {
    $shortcut = $Shell.CreateShortcut($temporaryShortcut)
    $shortcut.TargetPath = $ElectronPath
    $shortcut.Arguments = '.'
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = 'Launch Agent Universe Lite'
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    $shortcut = $null
    Move-Item -LiteralPath $temporaryShortcut -Destination $ShortcutPath -Force
    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
      throw "Shortcut staging failed: $ShortcutPath"
    }
  } finally {
    if ($null -ne $shortcut) {
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    if (Test-Path -LiteralPath $temporaryShortcut -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryShortcut -Force
    }
  }
}

function Publish-AgentUniverseArtifacts {
  param([Parameter(Mandatory = $true)][object[]]$Artifacts)

  $backups = [System.Collections.Generic.List[object]]::new()
  $published = [System.Collections.Generic.List[string]]::new()
  try {
    foreach ($artifact in $Artifacts) {
      if (-not (Test-Path -LiteralPath $artifact.Staged -PathType Leaf)) {
        throw "Staged artifact is missing: $($artifact.Staged)"
      }
      Assert-OwnedFileDestination $artifact.Final 'Owned artifact'
      if (Test-Path -LiteralPath $artifact.Final -PathType Leaf) {
        $backup = Join-Path -Path (Split-Path -Parent $artifact.Final) -ChildPath (
          '.agent-universe-lite-backup-' + [Guid]::NewGuid().ToString('N')
        )
        Move-Item -LiteralPath $artifact.Final -Destination $backup
        [void]$backups.Add([pscustomobject]@{ Backup = $backup; Final = $artifact.Final })
      }
    }

    foreach ($artifact in $Artifacts) {
      Move-Item -LiteralPath $artifact.Staged -Destination $artifact.Final
      if (-not (Test-Path -LiteralPath $artifact.Final -PathType Leaf)) {
        throw "Published artifact is missing: $($artifact.Final)"
      }
      [void]$published.Add($artifact.Final)
    }
  } catch {
    $publishError = $_
    $rollbackErrors = [System.Collections.Generic.List[string]]::new()
    for ($index = $published.Count - 1; $index -ge 0; $index--) {
      try {
        if (Test-Path -LiteralPath $published[$index] -PathType Leaf) {
          Remove-Item -LiteralPath $published[$index] -Force
        }
      } catch {
        [void]$rollbackErrors.Add($_.Exception.Message)
      }
    }
    for ($index = $backups.Count - 1; $index -ge 0; $index--) {
      try {
        if (Test-Path -LiteralPath $backups[$index].Backup -PathType Leaf) {
          Move-Item -LiteralPath $backups[$index].Backup -Destination $backups[$index].Final
        }
      } catch {
        [void]$rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($rollbackErrors.Count -gt 0) {
      throw "Artifact publish failed ($($publishError.Exception.Message)); rollback also failed: $($rollbackErrors -join '; ')"
    }
    throw $publishError
  }

  foreach ($backup in $backups) {
    if (Test-Path -LiteralPath $backup.Backup -PathType Leaf) {
      try {
        Remove-Item -LiteralPath $backup.Backup -Force
      } catch {
        Write-Warning (
          "Install committed successfully, but the previous-artifact backup " +
          "could not be removed: $($backup.Backup)"
        )
      }
    }
  }
}

function Remove-EmptyOwnedDirectory {
  param([Parameter(Mandatory = $true)][string]$Directory)

  if (Test-Path -LiteralPath $Directory -PathType Container) {
    $remaining = @(Get-ChildItem -LiteralPath $Directory -Force)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $Directory -Force
    }
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Agent Universe Lite shortcuts are supported only on Windows.'
}

$repo = ConvertTo-CanonicalPath $RepositoryRoot 'RepositoryRoot'
$desktop = ConvertTo-CanonicalPath $DesktopDirectory 'DesktopDirectory'
$programs = ConvertTo-CanonicalPath $ProgramsDirectory 'ProgramsDirectory'
$support = ConvertTo-CanonicalPath $SupportDirectory 'SupportDirectory'
$startMenuAppDirectory = Join-Path $programs 'Agent Universe Lite'
$desktopShortcut = Join-Path $desktop 'Agent Universe Lite.lnk'
$startMenuShortcut = Join-Path $startMenuAppDirectory 'Agent Universe Lite.lnk'
$icon = Join-Path $support 'agent-universe-lite.ico'

if ($Action -eq 'Uninstall') {
  foreach ($ownedFile in @($desktopShortcut, $startMenuShortcut, $icon)) {
    if (Test-Path -LiteralPath $ownedFile -PathType Leaf) {
      Remove-Item -LiteralPath $ownedFile -Force
    }
  }
  Remove-EmptyOwnedDirectory $startMenuAppDirectory
  Remove-EmptyOwnedDirectory $support
  [ordered]@{
    action = 'Uninstall'
    desktopShortcut = $desktopShortcut
    startMenuShortcut = $startMenuShortcut
    icon = $icon
  } | ConvertTo-Json -Compress
  exit 0
}

$packagePath = Join-Path $repo 'package.json'
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $repo -PathType Container)) {
  throw "RepositoryRoot does not exist: $repo"
}
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "Agent Universe Lite package.json was not found under: $repo"
}
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
if ($package.name -ne 'agent-universe-lite') {
  throw "RepositoryRoot is not Agent Universe Lite: $repo"
}
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw "Electron is not installed at $electron. Run npm install in $repo, then retry."
}

$desktopMissing = @(Get-MissingDirectoryChain $desktop 'DesktopDirectory')
$startMenuMissing = @(Get-MissingDirectoryChain $startMenuAppDirectory 'ProgramsDirectory')
$supportMissing = @(Get-MissingDirectoryChain $support 'SupportDirectory')
Assert-OwnedFileDestination $desktopShortcut 'Desktop shortcut'
Assert-OwnedFileDestination $startMenuShortcut 'Start-menu shortcut'
Assert-OwnedFileDestination $icon 'Support icon'

Add-Type -AssemblyName System.Drawing
$shell = $null
try {
  $shell = New-Object -ComObject WScript.Shell
} catch {
  throw "Windows shortcut support is unavailable: $($_.Exception.Message)"
}

try {
  try {
    [void][IO.Directory]::CreateDirectory($desktop)
    [void][IO.Directory]::CreateDirectory($startMenuAppDirectory)
    [void][IO.Directory]::CreateDirectory($support)
    $transaction = [Guid]::NewGuid().ToString('N')
    $stagedIcon = Join-Path $support ".agent-universe-lite-$transaction.ico"
    $stagedDesktop = Join-Path $desktop ".agent-universe-lite-$transaction.lnk"
    $stagedStartMenu = Join-Path $startMenuAppDirectory ".agent-universe-lite-$transaction.lnk"
    $stagedFiles = @($stagedIcon, $stagedDesktop, $stagedStartMenu)
    try {
      New-AgentUniverseIcon $stagedIcon
      Set-AgentUniverseShortcut $shell $stagedDesktop $electron $repo $icon
      Set-AgentUniverseShortcut $shell $stagedStartMenu $electron $repo $icon
      Publish-AgentUniverseArtifacts @(
        [pscustomobject]@{ Staged = $stagedIcon; Final = $icon },
        [pscustomobject]@{ Staged = $stagedDesktop; Final = $desktopShortcut },
        [pscustomobject]@{ Staged = $stagedStartMenu; Final = $startMenuShortcut }
      )
    } finally {
      foreach ($stagedFile in $stagedFiles) {
        if (Test-Path -LiteralPath $stagedFile -PathType Leaf) {
          Remove-Item -LiteralPath $stagedFile -Force
        }
      }
    }
  } catch {
    foreach ($created in @($desktopMissing) + @($startMenuMissing) + @($supportMissing)) {
      Remove-EmptyOwnedDirectory $created
    }
    throw
  }
} finally {
  if ($null -ne $shell) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}

[ordered]@{
  action = 'Install'
  desktopShortcut = $desktopShortcut
  startMenuShortcut = $startMenuShortcut
  icon = $icon
  target = $electron
  workingDirectory = $repo
} | ConvertTo-Json -Compress
