[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'preserve',
        'restore',
        'stop-processes',
        'remove-managed-runtime',
        'prepare-upgrade',
        'commit-upgrade',
        'rollback-upgrade'
    )]
    [string]$Action,

    [string]$Source,

    [string]$Backup,

    [string]$Target,

    [string]$TransactionRoot,

    [ValidateSet('current-user', 'all-users')]
    [string]$Scope,

    [string]$HkcuSource,

    [string]$HklmSource,

    [string]$InstallDirectory,

    [int]$ExcludedProcessId = 0,

    [string]$GracefulExecutableName,

    [int]$GracefulTimeoutSeconds = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:LegacyItems = @(
    [pscustomobject]@{ Relative = 'usersettings.yaml'; IsDirectory = $false },
    [pscustomobject]@{ Relative = 'gui_settings.json'; IsDirectory = $false },
    [pscustomobject]@{ Relative = 'task_groups.json'; IsDirectory = $false },
    [pscustomobject]@{ Relative = 'plans'; IsDirectory = $true },
    [pscustomobject]@{ Relative = 'templates'; IsDirectory = $true },
    [pscustomobject]@{
        Relative = 'resource\user_battle_plans'
        IsDirectory = $true
    },
    [pscustomobject]@{
        Relative = 'resource\user_daily_plans'
        IsDirectory = $true
    },
    [pscustomobject]@{
        Relative = 'resource\user_team_plans'
        IsDirectory = $true
    }
)
$script:PathComparison = [StringComparison]::OrdinalIgnoreCase
$script:TemporaryFilePattern = (
    '^\..+\.autowsgr-upgrade-[0-9a-fA-F]{32}\.tmp$'
)
$script:TransactionSchemaVersion = 2
$script:RuntimeRelativePath = 'python\site-packages'
$script:TransactionStates = @(
    'prepared',
    'preserved',
    'restoring',
    'restored',
    'complete'
)
$script:Utf8NoBom = New-Object Text.UTF8Encoding($false, $true)

function Assert-NoReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $($Item.FullName)"
    }
}

function Get-SafeFileSystemItem {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $item = Get-Item -Force -LiteralPath $Path
    if (
        -not ($item -is [IO.FileInfo]) -and
        -not ($item -is [IO.DirectoryInfo])
    ) {
        throw "$Label is not a regular file-system item: $Path"
    }
    Assert-NoReparsePoint $item $Label
    return $item
}

function Assert-PathChainSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $current = [IO.Path]::GetFullPath($Path)
    $isLeaf = $true
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-SafeFileSystemItem $current $Label
            if (-not $isLeaf -and -not $item.PSIsContainer) {
                throw "$Label has a file where a directory is required: $current"
            }
        }

        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            break
        }
        if ([string]::Equals(
            $parent.FullName,
            $current,
            $script:PathComparison
        )) {
            break
        }
        $current = $parent.FullName
        $isLeaf = $false
    }
}

function Get-CanonicalRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [bool]$MustExist
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "$Label path is empty"
    }

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    while (
        $fullPath.Length -gt $pathRoot.Length -and
        (
            $fullPath.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or
            $fullPath.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)
        )
    ) {
        $fullPath = $fullPath.Substring(0, $fullPath.Length - 1)
    }

    Assert-PathChainSafe $fullPath $Label
    if (Test-Path -LiteralPath $fullPath) {
        $rootItem = Get-SafeFileSystemItem $fullPath $Label
        if (-not $rootItem.PSIsContainer) {
            throw "$Label must be a directory: $fullPath"
        }
    }
    elseif ($MustExist) {
        throw "$Label directory does not exist: $fullPath"
    }

    return $fullPath
}

function Get-RootPrefix {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if (
        $Root.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or
        $Root.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)
    ) {
        return $Root
    }
    return $Root + [IO.Path]::DirectorySeparatorChar
}

function Test-IsSameOrDescendant {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Candidate,

        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if ([string]::Equals($Candidate, $Root, $script:PathComparison)) {
        return $true
    }
    return $Candidate.StartsWith(
        (Get-RootPrefix $Root),
        $script:PathComparison
    )
}

function Assert-SeparateRoots {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,

        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    if (
        (Test-IsSameOrDescendant $Left $Right) -or
        (Test-IsSameOrDescendant $Right $Left)
    ) {
        throw 'Installer data roots must not contain each other'
    }
}

function Get-ContainedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Relative
    )

    if (
        [string]::IsNullOrWhiteSpace($Relative) -or
        [IO.Path]::IsPathRooted($Relative)
    ) {
        throw "Invalid relative installer data path: $Relative"
    }
    foreach ($segment in @($Relative -split '[\\/]')) {
        if ($segment -eq '.' -or $segment -eq '..') {
            throw "Relative path traverses outside its root: $Relative"
        }
    }

    $fullPath = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $fullPath.StartsWith(
        (Get-RootPrefix $Root),
        $script:PathComparison
    )) {
        throw "Path escapes installer data root: $Relative"
    }
    return $fullPath
}

function Assert-ParentDirectoryTypes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Relative,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $parentRelative = Split-Path -Parent $Relative
    while (-not [string]::IsNullOrWhiteSpace($parentRelative)) {
        $parentPath = Get-ContainedPath $Root $parentRelative
        if (Test-Path -LiteralPath $parentPath) {
            $parentItem = Get-SafeFileSystemItem $parentPath $Label
            if (-not $parentItem.PSIsContainer) {
                throw "$Label parent is not a directory: $parentRelative"
            }
        }
        $nextParent = Split-Path -Parent $parentRelative
        if ($nextParent -eq $parentRelative) {
            break
        }
        $parentRelative = $nextParent
    }
}

function Assert-WhitelistLayout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    foreach ($definition in $script:LegacyItems) {
        Assert-ParentDirectoryTypes $Root $definition.Relative $Label
        $itemPath = Get-ContainedPath $Root $definition.Relative
        if (-not (Test-Path -LiteralPath $itemPath)) {
            continue
        }

        $item = Get-SafeFileSystemItem $itemPath $Label
        if ([bool]$item.PSIsContainer -ne $definition.IsDirectory) {
            throw "$Label has an invalid root item type: $($definition.Relative)"
        }
    }
}

function New-LegacyEntry {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item,

        [Parameter(Mandatory = $true)]
        [string]$Relative
    )

    $hash = $null
    if (-not $Item.PSIsContainer) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (
            $Item.FullName
        )).Hash
    }

    return [pscustomobject]@{
        Relative = $Relative
        FullName = [IO.Path]::GetFullPath($Item.FullName)
        IsDirectory = [bool]$Item.PSIsContainer
        Hash = $hash
    }
}

function Get-LegacyEntries {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [bool]$IgnoreInstallerTemps = $false
    )

    Assert-WhitelistLayout $Root $Label
    $entries = New-Object System.Collections.ArrayList
    foreach ($definition in $script:LegacyItems) {
        $rootPath = Get-ContainedPath $Root $definition.Relative
        if (-not (Test-Path -LiteralPath $rootPath)) {
            continue
        }

        $rootItem = Get-SafeFileSystemItem $rootPath $Label
        [void]$entries.Add((New-LegacyEntry $rootItem $definition.Relative))
        if (-not $rootItem.PSIsContainer) {
            continue
        }

        $queue = New-Object System.Collections.Queue
        $queue.Enqueue([pscustomobject]@{
            FullName = $rootItem.FullName
            Relative = $definition.Relative
        })
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            foreach ($child in @(Get-ChildItem -Force -LiteralPath (
                $current.FullName
            ))) {
                $child = Get-SafeFileSystemItem $child.FullName $Label
                $relative = Join-Path $current.Relative $child.Name
                $expected = Get-ContainedPath $Root $relative
                $actual = [IO.Path]::GetFullPath($child.FullName)
                if (-not [string]::Equals(
                    $actual,
                    $expected,
                    $script:PathComparison
                )) {
                    throw "$Label path changed during enumeration: $relative"
                }

                if (
                    $IgnoreInstallerTemps -and
                    -not $child.PSIsContainer -and
                    $child.Name -match $script:TemporaryFilePattern
                ) {
                    continue
                }

                [void]$entries.Add((New-LegacyEntry $child $relative))
                if ($child.PSIsContainer) {
                    $queue.Enqueue([pscustomobject]@{
                        FullName = $child.FullName
                        Relative = $relative
                    })
                }
            }
        }
    }

    return @($entries | Sort-Object @{
        Expression = { if ($_.IsDirectory) { 0 } else { 1 } }
    }, Relative)
}

function Get-EntryMap {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries
    )

    $map = @{}
    foreach ($entry in $Entries) {
        if ($map.ContainsKey($entry.Relative)) {
            throw "Duplicate legacy data path: $($entry.Relative)"
        }
        $map[$entry.Relative] = $entry
    }
    return $map
}

function Assert-EntriesEqual {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [object]$Actual,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($Expected.IsDirectory -ne $Actual.IsDirectory) {
        throw "$Label type conflict: $($Expected.Relative)"
    }
    if (-not $Expected.IsDirectory -and $Expected.Hash -ne $Actual.Hash) {
        throw "$Label content conflict: $($Expected.Relative)"
    }
}

function Assert-EntriesCovered {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ExpectedEntries,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ActualEntries,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $actualMap = Get-EntryMap $ActualEntries
    foreach ($expectedEntry in $ExpectedEntries) {
        if (-not $actualMap.ContainsKey($expectedEntry.Relative)) {
            throw "$Label is missing: $($expectedEntry.Relative)"
        }
        Assert-EntriesEqual (
            $expectedEntry
        ) $actualMap[$expectedEntry.Relative] $Label
    }
}

function Assert-EntrySetsEqual {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ExpectedEntries,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ActualEntries,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($ExpectedEntries.Count -ne $ActualEntries.Count) {
        throw "$Label entry count changed"
    }
    Assert-EntriesCovered $ExpectedEntries $ActualEntries $Label
}

function Test-PreservedMarker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BackupRoot,

        [bool]$Required = $false
    )

    $marker = Get-ContainedPath $BackupRoot '.preserved'
    if (-not (Test-Path -LiteralPath $marker)) {
        if ($Required) {
            throw 'Legacy backup is incomplete: .preserved is missing'
        }
        return $false
    }

    $markerItem = Get-SafeFileSystemItem $marker 'Legacy backup marker'
    if ($markerItem.PSIsContainer) {
        throw 'Legacy backup marker must be a file'
    }
    if ($markerItem.Length -ne 0) {
        throw 'Legacy backup marker must be empty'
    }
    return $true
}

function Write-PreservedMarker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BackupRoot
    )

    if (Test-PreservedMarker $BackupRoot $false) {
        return
    }

    $marker = Get-ContainedPath $BackupRoot '.preserved'
    $stream = [IO.File]::Open(
        $marker,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    $stream.Dispose()
    [void](Test-PreservedMarker $BackupRoot $true)
}

function Remove-InstallerTemps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $Root)) {
        return
    }
    Assert-WhitelistLayout $Root $Label

    foreach ($definition in $script:LegacyItems) {
        $rootPath = Get-ContainedPath $Root $definition.Relative
        if (-not $definition.IsDirectory) {
            $parent = Split-Path -Parent $rootPath
            $leaf = Split-Path -Leaf $rootPath
            $pattern = (
                '^\.' + [regex]::Escape($leaf) +
                '\.autowsgr-upgrade-[0-9a-fA-F]{32}\.tmp$'
            )
            foreach ($candidate in @(Get-ChildItem -Force -LiteralPath $parent)) {
                if ($candidate.PSIsContainer -or $candidate.Name -notmatch $pattern) {
                    continue
                }
                $candidate = Get-SafeFileSystemItem $candidate.FullName $Label
                Remove-Item -Force -LiteralPath $candidate.FullName
            }
            continue
        }

        if (-not (Test-Path -LiteralPath $rootPath)) {
            continue
        }
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue($rootPath)
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            foreach ($candidate in @(Get-ChildItem -Force -LiteralPath $current)) {
                $candidate = Get-SafeFileSystemItem $candidate.FullName $Label
                if ($candidate.PSIsContainer) {
                    $queue.Enqueue($candidate.FullName)
                }
                elseif ($candidate.Name -match $script:TemporaryFilePattern) {
                    Remove-Item -Force -LiteralPath $candidate.FullName
                }
            }
        }
    }
}

function Assert-ManagedRuntimeTreeSafe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimePath
    )

    $extendedRoot = '\\?\' + $RuntimePath
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($extendedRoot)
    while ($queue.Count -gt 0) {
        $current = [string]$queue.Dequeue()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            $attributes = [IO.File]::GetAttributes($entry)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Managed runtime directory contains a reparse point: $entry"
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $queue.Enqueue($entry)
            }
        }
    }
}

function Remove-ManagedRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot
    )

    $root = Get-CanonicalRoot $InstallRoot 'Install directory' $true
    $runtime = Get-ContainedPath $root $script:RuntimeRelativePath
    if (-not (Test-Path -LiteralPath $runtime)) {
        return
    }

    Assert-PathChainSafe $runtime 'Managed runtime directory'
    $runtimeItem = Get-SafeFileSystemItem $runtime 'Managed runtime directory'
    if (-not $runtimeItem.PSIsContainer) {
        throw "Managed runtime path must be a directory: $runtime"
    }

    Assert-ManagedRuntimeTreeSafe $runtimeItem.FullName
    [IO.Directory]::Delete('\\?\' + $runtimeItem.FullName, $true)
    if (Test-Path -LiteralPath $runtime) {
        throw "Managed runtime directory still exists after deletion: $runtime"
    }
}

function Ensure-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    Assert-PathChainSafe $Path $Label
    if (Test-Path -LiteralPath $Path) {
        $item = Get-SafeFileSystemItem $Path $Label
        if (-not $item.PSIsContainer) {
            throw "$Label must be a directory: $Path"
        }
        return
    }

    [void][IO.Directory]::CreateDirectory($Path)
    $created = Get-SafeFileSystemItem $Path $Label
    if (-not $created.PSIsContainer) {
        throw "$Label must be a directory: $Path"
    }
    Assert-PathChainSafe $Path $Label
}

function Copy-FileAtomically {
    param(
        [Parameter(Mandatory = $true)]
        [object]$SourceEntry,

        [Parameter(Mandatory = $true)]
        [string]$Destination,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ($SourceEntry.IsDirectory) {
        throw "Cannot copy a directory as a file: $($SourceEntry.Relative)"
    }

    $sourceItem = Get-SafeFileSystemItem $SourceEntry.FullName $Label
    if ($sourceItem.PSIsContainer) {
        throw "$Label source became a directory: $($SourceEntry.Relative)"
    }
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (
        $sourceItem.FullName
    )).Hash
    if ($sourceHash -ne $SourceEntry.Hash) {
        throw "$Label source changed before copy: $($SourceEntry.Relative)"
    }

    $parent = Split-Path -Parent $Destination
    Ensure-SafeDirectory $parent $Label
    Assert-PathChainSafe $Destination $Label
    if (Test-Path -LiteralPath $Destination) {
        throw "$Label destination appeared during copy: $($SourceEntry.Relative)"
    }

    $temporary = Join-Path $parent (
        '.' + [IO.Path]::GetFileName($Destination) +
        '.autowsgr-upgrade-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    )
    try {
        [IO.File]::Copy($sourceItem.FullName, $temporary, $false)
        $temporaryItem = Get-SafeFileSystemItem $temporary $Label
        if ($temporaryItem.PSIsContainer) {
            throw "$Label temporary path became a directory"
        }
        $temporaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (
            $temporary
        )).Hash
        if ($temporaryHash -ne $SourceEntry.Hash) {
            throw "$Label source changed while copying: $($SourceEntry.Relative)"
        }
        if (Test-Path -LiteralPath $Destination) {
            throw "$Label destination appeared during copy: $($SourceEntry.Relative)"
        }
        [IO.File]::Move($temporary, $Destination)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            $temporaryItem = Get-SafeFileSystemItem $temporary $Label
            Remove-Item -Force -LiteralPath $temporaryItem.FullName
        }
    }
}

function Get-LegacyTreeDigest {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries
    )

    $lines = @(
        $Entries |
            Sort-Object Relative |
            ForEach-Object {
                $kind = if ($_.IsDirectory) { 'D' } else { 'F' }
                $hash = if ($_.IsDirectory) { '' } else { $_.Hash }
                "$kind`t$($_.Relative)`t$hash"
            }
    )
    $bytes = $script:Utf8NoBom.GetBytes(($lines -join "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString(
            $sha.ComputeHash($bytes)
        )).Replace('-', '')
    }
    finally {
        $sha.Dispose()
    }
}

function Get-RuntimeEntries {
    param([string]$Root, [string]$Label)
    $rootItem = Get-SafeFileSystemItem $Root $Label
    if (-not $rootItem.PSIsContainer) { throw "$Label must be a directory" }
    $entries = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([pscustomobject]@{ FullName = $rootItem.FullName; Relative = '' })
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($child in @(Get-ChildItem -Force -LiteralPath $current.FullName)) {
            $child = Get-SafeFileSystemItem $child.FullName $Label
            $relative = if ($current.Relative) {
                Join-Path $current.Relative $child.Name
            } else { $child.Name }
            if (-not [string]::Equals(
                [IO.Path]::GetFullPath($child.FullName),
                (Get-ContainedPath $Root $relative),
                $script:PathComparison
            )) { throw "$Label path changed during enumeration" }
            [void]$entries.Add((New-LegacyEntry $child $relative))
            if ($child.PSIsContainer) {
                $queue.Enqueue([pscustomobject]@{
                    FullName = $child.FullName; Relative = $relative
                })
            }
        }
    }
    return @($entries | Sort-Object @{
        Expression = { if ($_.IsDirectory) { 0 } else { 1 } }
    }, Relative)
}

function Get-RuntimeSnapshot {
    param([string]$Root, [string]$Label)
    $entries = @(Get-RuntimeEntries $Root $Label)
    return [pscustomobject]@{
        EntryCount = $entries.Count
        Digest = Get-LegacyTreeDigest $entries
    }
}

function Assert-RuntimeSnapshot {
    param([string]$Root, [object]$Artifact, [string]$Label)
    if (-not [IO.Directory]::Exists($Root)) { throw "$Label is missing" }
    $snapshot = Get-RuntimeSnapshot $Root $Label
    if ($snapshot.EntryCount -ne [int]$Artifact.entryCount -or
        $snapshot.Digest -ne [string]$Artifact.digest) {
        throw "$Label does not match its manifest"
    }
}

function Get-RuntimeStagingPath {
    param([string]$SourceRoot, [string]$TransactionId)
    $path = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $SourceRoot) (
        '.' + (Split-Path -Leaf $SourceRoot) +
        '.autowsgr-runtime-' + $TransactionId
    )))
    Assert-PathChainSafe $path 'Runtime staging path'
    Assert-SeparateRoots $SourceRoot $path
    if (-not [string]::Equals(
        [IO.Path]::GetPathRoot($SourceRoot),
        [IO.Path]::GetPathRoot($path),
        $script:PathComparison
    )) { throw 'Runtime staging must share the source volume' }
    return $path
}

function Assert-SourceSetsCompatible {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$SourceSets
    )

    $combined = @{}
    foreach ($sourceSet in $SourceSets) {
        foreach ($entry in $sourceSet.Entries) {
            if ($combined.ContainsKey($entry.Relative)) {
                Assert-EntriesEqual (
                    $combined[$entry.Relative]
                ) $entry 'Legacy upgrade sources'
            }
            else {
                $combined[$entry.Relative] = $entry
            }
        }
    }
}

function New-TransactionSourceDescriptor {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hive,

        [AllowEmptyString()]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$BackupRelative,

        [Parameter(Mandatory = $true)]
        [string]$TransactionId
    )

    if ([string]::IsNullOrWhiteSpace($SourcePath)) {
        return $null
    }
    $sourceRoot = Get-CanonicalRoot $SourcePath (
        "$Hive legacy source"
    ) $false
    if (-not [IO.Directory]::Exists($sourceRoot)) {
        return $null
    }
    Assert-WhitelistLayout $sourceRoot "$Hive legacy source"
    $entries = @(Get-LegacyEntries $sourceRoot "$Hive legacy source")
    $runtimeArtifact = $null
    $runtimePath = Get-ContainedPath $sourceRoot $script:RuntimeRelativePath
    if ([IO.Directory]::Exists($runtimePath)) {
        $snapshot = Get-RuntimeSnapshot $runtimePath "$Hive runtime"
        $runtimeArtifact = [pscustomobject]@{
            RelativePath = $script:RuntimeRelativePath
            StagingPath = Get-RuntimeStagingPath $sourceRoot $TransactionId
            EntryCount = $snapshot.EntryCount
            Digest = $snapshot.Digest
        }
    } elseif (Test-Path -LiteralPath $runtimePath) {
        throw "$Hive runtime must be a directory"
    }
    return [pscustomobject]@{
        Hives = @($Hive)
        Path = $sourceRoot
        BackupRelative = $BackupRelative
        EntryCount = $entries.Count
        Digest = Get-LegacyTreeDigest $entries
        Entries = $entries
        RuntimeArtifact = $runtimeArtifact
    }
}

function Get-ExpectedTransactionSources {
    param(
        [AllowEmptyString()]
        [string]$HkcuPath,

        [AllowEmptyString()]
        [string]$HklmPath,

        [Parameter(Mandatory = $true)]
        [string]$InstallScope,

        [Parameter(Mandatory = $true)]
        [string]$TransactionId
    )

    $sourceSets = New-Object System.Collections.ArrayList
    $hkcu = New-TransactionSourceDescriptor (
        'HKCU'
    ) $HkcuPath 'sources\hkcu' $TransactionId
    if ($null -ne $hkcu) {
        [void]$sourceSets.Add($hkcu)
    }
    if ($InstallScope -eq 'all-users') {
        $hklm = New-TransactionSourceDescriptor (
            'HKLM'
        ) $HklmPath 'sources\hklm' $TransactionId
        if ($null -ne $hklm) {
            $matching = @(
                $sourceSets |
                    Where-Object {
                        [string]::Equals(
                            $_.Path,
                            $hklm.Path,
                            $script:PathComparison
                        )
                    }
            )
            if ($matching.Count -eq 1) {
                $matching[0].Hives = @('HKCU', 'HKLM')
            }
            else {
                [void]$sourceSets.Add($hklm)
            }
        }
    }
    Assert-SourceSetsCompatible $sourceSets
    if (@($sourceSets | Where-Object { $null -ne $_.RuntimeArtifact }).Count -gt 1) {
        throw 'Multiple legacy sources contain managed runtime artifacts'
    }
    return @($sourceSets)
}

function Get-TransactionRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [Parameter(Mandatory = $true)]
        [bool]$Create
    )

    $root = Get-CanonicalRoot $RootPath 'Upgrade transaction root' $false
    $transactions = Get-ContainedPath $root 'transactions'
    if (-not $Create -and -not [IO.Directory]::Exists($transactions)) {
        if (Test-Path -LiteralPath $transactions) {
            [void](Get-CanonicalRoot (
                $transactions
            ) 'Upgrade transaction directory' $true)
        }
        return $null
    }
    Ensure-SafeDirectory $root 'Upgrade transaction root'
    Ensure-SafeDirectory $transactions 'Upgrade transaction directory'
    return $transactions
}

function Get-TransactionManifestPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionDirectory
    )

    return Get-ContainedPath $TransactionDirectory 'transaction.json'
}

function Convert-ManifestSourceForWrite {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Source
    )

    $runtimeArtifact = $null
    if ($null -ne $Source.RuntimeArtifact) {
        $runtimeArtifact = [ordered]@{
            relativePath = $Source.RuntimeArtifact.RelativePath
            stagingPath = $Source.RuntimeArtifact.StagingPath
            entryCount = [int]$Source.RuntimeArtifact.EntryCount
            digest = $Source.RuntimeArtifact.Digest
        }
    }
    return [ordered]@{
        hives = @($Source.Hives)
        path = $Source.Path
        backupRelative = $Source.BackupRelative
        entryCount = [int]$Source.EntryCount
        digest = $Source.Digest
        runtimeArtifact = $runtimeArtifact
    }
}

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $parent = Split-Path -Parent $Path
    Ensure-SafeDirectory $parent 'Upgrade transaction manifest directory'
    Assert-PathChainSafe $Path 'Upgrade transaction manifest'
    $temporary = Join-Path $parent (
        '.transaction.autowsgr-upgrade-' +
        [Guid]::NewGuid().ToString('N') + '.tmp'
    )
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    $bytes = $script:Utf8NoBom.GetBytes($json)
    $stream = $null
    try {
        $stream = New-Object IO.FileStream(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [void](
            [IO.File]::ReadAllText(
                $temporary,
                $script:Utf8NoBom
            ) | ConvertFrom-Json
        )
        if (Test-Path -LiteralPath $Path) {
            $replacementBackup = Join-Path $parent (
                '.transaction.autowsgr-upgrade-' +
                [Guid]::NewGuid().ToString('N') + '.bak'
            )
            try {
                [IO.File]::Replace(
                    $temporary,
                    $Path,
                    $replacementBackup,
                    $true
                )
            }
            finally {
                if (Test-Path -LiteralPath $replacementBackup) {
                    Remove-Item -Force -LiteralPath $replacementBackup
                }
            }
        }
        else {
            [IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -Force -LiteralPath $temporary
        }
    }
}

function Read-TransactionManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ManifestPath
    )

    $manifestItem = Get-SafeFileSystemItem (
        $ManifestPath
    ) 'Upgrade transaction manifest'
    if ($manifestItem.PSIsContainer) {
        throw 'Upgrade transaction manifest must be a file'
    }
    try {
        return [IO.File]::ReadAllText(
            $manifestItem.FullName,
            $script:Utf8NoBom
        ) | ConvertFrom-Json
    }
    catch {
        throw "Invalid upgrade transaction manifest: $($_.Exception.Message)"
    }
}

function Assert-ManifestPropertySet {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string[]]$Expected,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $actual = @($Object.PSObject.Properties.Name | Sort-Object)
    $expectedNames = @($Expected | Sort-Object)
    if (($actual -join "`n") -ne ($expectedNames -join "`n")) {
        throw "$Label has unexpected fields"
    }
}

function Assert-TransactionManifest {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest,

        [Parameter(Mandatory = $true)]
        [string]$TransactionDirectory
    )

    Assert-ManifestPropertySet $Manifest @(
        'schemaVersion',
        'transactionId',
        'state',
        'target',
        'scope',
        'sources'
    ) 'Upgrade transaction manifest'
    if ([int]$Manifest.schemaVersion -ne $script:TransactionSchemaVersion) {
        throw 'Unsupported upgrade transaction schema'
    }
    $transactionId = [string]$Manifest.transactionId
    if ($transactionId -notmatch '^[0-9a-f]{32}$') {
        throw 'Invalid upgrade transaction ID'
    }
    if (-not [string]::Equals(
        (Split-Path -Leaf $TransactionDirectory),
        $transactionId,
        [StringComparison]::Ordinal
    )) {
        throw 'Upgrade transaction directory does not match its ID'
    }
    if ($script:TransactionStates -notcontains [string]$Manifest.state) {
        throw 'Invalid upgrade transaction state'
    }
    if (@('current-user', 'all-users') -notcontains [string]$Manifest.scope) {
        throw 'Invalid upgrade transaction scope'
    }
    $target = Get-CanonicalRoot (
        [string]$Manifest.target
    ) 'Upgrade transaction target' $false
    if (-not [string]::Equals(
        $target,
        [string]$Manifest.target,
        $script:PathComparison
    )) {
        throw 'Upgrade transaction target is not canonical'
    }

    $seenHives = @{}
    $seenPaths = @{}
    foreach ($source in @($Manifest.sources)) {
        Assert-ManifestPropertySet $source @(
            'hives',
            'path',
            'backupRelative',
            'entryCount',
            'digest',
            'runtimeArtifact'
        ) 'Upgrade transaction source'
        if (@($source.hives).Count -eq 0) {
            throw 'Upgrade transaction source must bind at least one registry hive'
        }
        foreach ($hive in @($source.hives)) {
            if (@('HKCU', 'HKLM') -notcontains [string]$hive) {
                throw 'Invalid upgrade transaction registry hive'
            }
            if (
                [string]$Manifest.scope -eq 'current-user' -and
                [string]$hive -eq 'HKLM'
            ) {
                throw 'Current-user transaction cannot bind an HKLM source'
            }
            if ($seenHives.ContainsKey([string]$hive)) {
                throw 'Duplicate upgrade transaction registry hive'
            }
            $seenHives[[string]$hive] = $true
        }
        $sourcePath = Get-CanonicalRoot (
            [string]$source.path
        ) 'Upgrade transaction source' $false
        if (-not [string]::Equals(
            $sourcePath,
            [string]$source.path,
            $script:PathComparison
        )) {
            throw 'Upgrade transaction source is not canonical'
        }
        if ($seenPaths.ContainsKey($sourcePath)) {
            throw 'Duplicate upgrade transaction source path'
        }
        $seenPaths[$sourcePath] = $true
        [void](Get-ContainedPath (
            $TransactionDirectory
        ) ([string]$source.backupRelative))
        if ([int]$source.entryCount -lt 0) {
            throw 'Invalid upgrade transaction entry count'
        }
        if ([string]$source.digest -notmatch '^[0-9A-F]{64}$') {
            throw 'Invalid upgrade transaction digest'
        }
        if ($null -ne $source.runtimeArtifact) {
            Assert-ManifestPropertySet $source.runtimeArtifact @(
                'relativePath', 'stagingPath', 'entryCount', 'digest'
            ) 'Upgrade runtime artifact'
            if ([string]$source.runtimeArtifact.relativePath -ne $script:RuntimeRelativePath) {
                throw 'Invalid upgrade runtime relative path'
            }
            $stagingPath = Get-CanonicalRoot (
                [string]$source.runtimeArtifact.stagingPath
            ) 'Upgrade runtime staging' $false
            $expectedStagingPath = Get-RuntimeStagingPath (
                $sourcePath
            ) $transactionId
            if (-not [string]::Equals(
                $stagingPath,
                $expectedStagingPath,
                $script:PathComparison
            )) {
                throw 'Upgrade runtime staging does not match transaction identity'
            }
            Assert-SeparateRoots $sourcePath $stagingPath
            if (-not [string]::Equals(
                [IO.Path]::GetPathRoot($sourcePath),
                [IO.Path]::GetPathRoot($stagingPath),
                $script:PathComparison
            )) { throw 'Upgrade runtime staging must share the source volume' }
            if ([int]$source.runtimeArtifact.entryCount -lt 0) {
                throw 'Invalid upgrade runtime entry count'
            }
            if ([string]$source.runtimeArtifact.digest -notmatch '^[0-9A-F]{64}$') {
                throw 'Invalid upgrade runtime digest'
            }
        }
    }
}

function Get-IncompleteTransaction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionsRoot
    )

    $incomplete = @()
    foreach ($directory in @(Get-ChildItem -Force -LiteralPath $TransactionsRoot)) {
        $directory = Get-SafeFileSystemItem (
            $directory.FullName
        ) 'Upgrade transaction entry'
        if (-not $directory.PSIsContainer) {
            throw 'Upgrade transaction root contains an unexpected file'
        }
        $manifestPath = Get-TransactionManifestPath $directory.FullName
        if (-not (Test-Path -LiteralPath $manifestPath)) {
            throw 'Upgrade transaction directory is missing transaction.json'
        }
        $manifest = Read-TransactionManifest $manifestPath
        Assert-TransactionManifest $manifest $directory.FullName
        if ([string]$manifest.state -ne 'complete') {
            $incomplete += [pscustomobject]@{
                Directory = $directory.FullName
                ManifestPath = $manifestPath
                Manifest = $manifest
            }
        }
    }
    if ($incomplete.Count -gt 1) {
        throw 'Multiple incomplete upgrade transactions exist'
    }
    if ($incomplete.Count -eq 1) {
        return $incomplete[0]
    }
    return $null
}

function Test-CompletedTransactionIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionsRoot,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedTarget,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedScope
    )

    $hasTransactions = $false
    foreach ($directory in @(Get-ChildItem -Force -LiteralPath $TransactionsRoot)) {
        $directory = Get-SafeFileSystemItem (
            $directory.FullName
        ) 'Upgrade transaction entry'
        if (-not $directory.PSIsContainer) {
            throw 'Upgrade transaction root contains an unexpected file'
        }
        $hasTransactions = $true
        $manifestPath = Get-TransactionManifestPath $directory.FullName
        if (-not (Test-Path -LiteralPath $manifestPath)) {
            throw 'Upgrade transaction directory is missing transaction.json'
        }
        $manifest = Read-TransactionManifest $manifestPath
        Assert-TransactionManifest $manifest $directory.FullName
        if (
            [string]$manifest.state -eq 'complete' -and
            [string]::Equals(
                [string]$manifest.target,
                $ExpectedTarget,
                $script:PathComparison
            ) -and
            [string]$manifest.scope -eq $ExpectedScope
        ) {
            return $true
        }
    }
    if ($hasTransactions) {
        throw 'No completed upgrade transaction matches this identity'
    }
    return $false
}

function Assert-TransactionBaseIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedTarget,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedScope
    )

    if (-not [string]::Equals(
        [string]$Manifest.target,
        $ExpectedTarget,
        $script:PathComparison
    ) -or [string]$Manifest.scope -ne $ExpectedScope) {
        throw 'Incomplete upgrade transaction identity does not match'
    }
}

function Assert-TransactionSourceIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ExpectedSources
    )

    $actualSources = @($Manifest.sources)
    if ($actualSources.Count -ne $ExpectedSources.Count) {
        throw 'Incomplete upgrade transaction source set does not match'
    }
    foreach ($expected in $ExpectedSources) {
        $actual = @(
            $actualSources |
                Where-Object {
                    [string]::Equals(
                        [string]$_.path,
                        $expected.Path,
                        $script:PathComparison
                    )
                }
        )
        if ($actual.Count -ne 1) {
            throw 'Incomplete upgrade transaction source path does not match'
        }
        if (
            (@($actual[0].hives) -join ',') -ne
            (@($expected.Hives) -join ',') -or
            [string]$actual[0].backupRelative -ne $expected.BackupRelative -or
            [int]$actual[0].entryCount -ne $expected.EntryCount -or
            [string]$actual[0].digest -ne $expected.Digest
        ) {
            throw 'Incomplete upgrade transaction source snapshot does not match'
        }
    }
}

function Assert-TransactionInputIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest,

        [AllowEmptyString()]
        [string]$HkcuPath,

        [AllowEmptyString()]
        [string]$HklmPath,

        [Parameter(Mandatory = $true)]
        [string]$InstallScope
    )

    $expectedInputs = @(
        @(
            [pscustomobject]@{ Hive = 'HKCU'; Path = $HkcuPath },
            [pscustomobject]@{ Hive = 'HKLM'; Path = $HklmPath }
        ) | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_.Path) -and
            ($_.Hive -eq 'HKCU' -or $InstallScope -eq 'all-users')
        }
    )
    $manifestHives = @(
        $Manifest.sources |
            ForEach-Object { @($_.hives) }
    )
    if ($expectedInputs.Count -ne $manifestHives.Count) {
        throw 'Incomplete upgrade transaction source set does not match'
    }

    foreach ($expected in $expectedInputs) {
        $canonical = Get-CanonicalRoot $expected.Path (
            "$($expected.Hive) legacy source"
        ) $false
        $matching = @($Manifest.sources | Where-Object {
            @($_.hives) -contains $expected.Hive -and
            [string]::Equals(
                [string]$_.path,
                $canonical,
                $script:PathComparison
            )
        })
        if ($matching.Count -ne 1) {
            throw 'Incomplete upgrade transaction source identity does not match'
        }
    }
}

function Write-TransactionManifestState {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Transaction,

        [Parameter(Mandatory = $true)]
        [string]$State
    )

    $manifest = [ordered]@{
        schemaVersion = [int]$Transaction.Manifest.schemaVersion
        transactionId = [string]$Transaction.Manifest.transactionId
        state = $State
        target = [string]$Transaction.Manifest.target
        scope = [string]$Transaction.Manifest.scope
        sources = @($Transaction.Manifest.sources)
    }
    Write-JsonAtomically $Transaction.ManifestPath $manifest
    $Transaction.Manifest = Read-TransactionManifest $Transaction.ManifestPath
    Assert-TransactionManifest $Transaction.Manifest $Transaction.Directory
}

function New-UpgradeTransaction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TransactionsRoot,

        [Parameter(Mandatory = $true)]
        [string]$TargetRoot,

        [Parameter(Mandatory = $true)]
        [string]$InstallScope,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Sources,

        [Parameter(Mandatory = $true)]
        [string]$TransactionId
    )

    $directory = Get-ContainedPath $TransactionsRoot $transactionId
    Ensure-SafeDirectory $directory 'Upgrade transaction directory'
    $manifestPath = Get-TransactionManifestPath $directory
    $manifest = [ordered]@{
        schemaVersion = $script:TransactionSchemaVersion
        transactionId = $transactionId
        state = 'prepared'
        target = $TargetRoot
        scope = $InstallScope
        sources = @($Sources | ForEach-Object {
            Convert-ManifestSourceForWrite $_
        })
    }
    Write-JsonAtomically $manifestPath $manifest
    $result = [pscustomobject]@{
        Directory = $directory
        ManifestPath = $manifestPath
        Manifest = Read-TransactionManifest $manifestPath
    }
    Assert-TransactionManifest $result.Manifest $result.Directory
    return $result
}

function Assert-TransactionBackups {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Transaction
    )

    foreach ($source in @($Transaction.Manifest.sources)) {
        $backup = Get-ContainedPath (
            $Transaction.Directory
        ) ([string]$source.backupRelative)
        $entries = @(Get-LegacyEntries $backup 'Upgrade transaction backup' $true)
        if ($entries.Count -ne [int]$source.entryCount -or (
            Get-LegacyTreeDigest $entries
        ) -ne [string]$source.digest) {
            throw 'Upgrade transaction backup does not match its manifest'
        }
        [void](Test-PreservedMarker $backup $true)
    }
}

function Get-ManifestRuntimeSource {
    param([object]$Manifest)
    $sources = @($Manifest.sources | Where-Object { $null -ne $_.runtimeArtifact })
    if ($sources.Count -gt 1) { throw 'Multiple runtime artifacts in transaction' }
    if ($sources.Count -eq 1) { return $sources[0] }
    return $null
}

function Move-RuntimeToStaging {
    param([object]$Manifest)
    $source = Get-ManifestRuntimeSource $Manifest
    if ($null -eq $source) { return }
    $artifact = $source.runtimeArtifact
    $runtime = Get-ContainedPath ([string]$source.path) ([string]$artifact.relativePath)
    $staging = [string]$artifact.stagingPath
    $runtimeExists = [IO.Directory]::Exists($runtime)
    $stagingExists = [IO.Directory]::Exists($staging)
    if ($runtimeExists -and $stagingExists) {
        throw 'Managed runtime exists in source and staging'
    }
    if ($stagingExists) {
        Assert-RuntimeSnapshot $staging $artifact 'Managed runtime staging'
        return
    }
    if (-not $runtimeExists) { throw 'Managed runtime is missing' }
    Assert-RuntimeSnapshot $runtime $artifact 'Managed runtime source'
    [IO.Directory]::Move($runtime, $staging)
    Assert-RuntimeSnapshot $staging $artifact 'Managed runtime staging'
}

function Restore-RuntimeArtifact {
    param([object]$Manifest, [string]$DestinationRoot, [string]$Label)
    $source = Get-ManifestRuntimeSource $Manifest
    if ($null -eq $source) { return }
    $artifact = $source.runtimeArtifact
    $staging = [string]$artifact.stagingPath
    $destination = Get-ContainedPath $DestinationRoot ([string]$artifact.relativePath)
    $stagingExists = [IO.Directory]::Exists($staging)
    $destinationExists = [IO.Directory]::Exists($destination)
    if ($stagingExists -and $destinationExists) {
        throw "$Label exists in staging and destination"
    }
    if ($destinationExists) {
        Assert-RuntimeSnapshot $destination $artifact "$Label destination"
        return
    }
    if (-not $stagingExists) { throw "$Label is missing" }
    Assert-RuntimeSnapshot $staging $artifact "$Label staging"
    Ensure-SafeDirectory (Split-Path -Parent $destination) "$Label parent"
    [IO.Directory]::Move($staging, $destination)
    Assert-RuntimeSnapshot $destination $artifact "$Label destination"
}

function Assert-RuntimePreserved {
    param([object]$Manifest)
    $source = Get-ManifestRuntimeSource $Manifest
    if ($null -eq $source) { return }
    $runtime = Get-ContainedPath ([string]$source.path) (
        [string]$source.runtimeArtifact.relativePath
    )
    if (Test-Path -LiteralPath $runtime) {
        throw 'Managed runtime remains in legacy source'
    }
    Assert-RuntimeSnapshot (
        [string]$source.runtimeArtifact.stagingPath
    ) $source.runtimeArtifact 'Managed runtime staging'
}

function Invoke-PrepareUpgrade {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath,

        [Parameter(Mandatory = $true)]
        [string]$InstallScope,

        [AllowEmptyString()]
        [string]$HkcuPath,

        [AllowEmptyString()]
        [string]$HklmPath,

        [Parameter(Mandatory = $true)]
        [int]$ExcludedId,

        [Parameter(Mandatory = $true)]
        [string]$GracefulName,

        [Parameter(Mandatory = $true)]
        [int]$GracefulTimeout
    )

    $targetRoot = Get-CanonicalRoot $TargetPath 'Upgrade target' $false
    $transactionsRoot = Get-TransactionRoot $RootPath $false
    $transaction = $null
    if ($null -ne $transactionsRoot) {
        $transaction = Get-IncompleteTransaction $transactionsRoot
    }

    if ($null -ne $transaction) {
        Assert-TransactionBaseIdentity (
            $transaction.Manifest
        ) $targetRoot $InstallScope
        Assert-TransactionInputIdentity (
            $transaction.Manifest
        ) $HkcuPath $HklmPath $InstallScope
    }

    $sources = @()
    $transactionId = $null
    if ($null -eq $transaction) {
        $transactionId = [Guid]::NewGuid().ToString('N')
        $sources = @(Get-ExpectedTransactionSources (
            $HkcuPath
        ) $HklmPath $InstallScope $transactionId)
    }

    if ($null -eq $transaction) {
        $transactionsRoot = Get-TransactionRoot $RootPath $true
        $transaction = New-UpgradeTransaction (
            $transactionsRoot
        ) $targetRoot $InstallScope $sources $transactionId
    }
    elseif ([string]$transaction.Manifest.state -ne 'prepared') {
        Assert-TransactionBackups $transaction
    }

    if ([string]$transaction.Manifest.state -eq 'prepared') {
        foreach ($source in @($transaction.Manifest.sources)) {
            Invoke-StopProcesses ([string]$source.path) (
                $ExcludedId
            ) $GracefulName $GracefulTimeout
        }
        Move-RuntimeToStaging $transaction.Manifest
        foreach ($manifestSource in @($transaction.Manifest.sources)) {
            $backup = Get-ContainedPath (
                $transaction.Directory
            ) ([string]$manifestSource.backupRelative)
            $sourceEntries = @(Get-LegacyEntries (
                [string]$manifestSource.path
            ) 'Legacy source')
            if ($sourceEntries.Count -ne [int]$manifestSource.entryCount -or
                (Get-LegacyTreeDigest $sourceEntries) -ne [string]$manifestSource.digest) {
                throw 'Legacy source changed before preservation'
            }
            Invoke-Preserve ([string]$manifestSource.path) $backup
        }
        Assert-TransactionBackups $transaction
        Assert-RuntimePreserved $transaction.Manifest
        Write-TransactionManifestState $transaction 'preserved'
    }
    else {
        Assert-TransactionBackups $transaction
        Assert-RuntimePreserved $transaction.Manifest
    }
}

function Get-RestoreEntriesFromTransaction {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Transaction
    )

    $entryMap = @{}
    foreach ($source in @($Transaction.Manifest.sources)) {
        $backup = Get-ContainedPath (
            $Transaction.Directory
        ) ([string]$source.backupRelative)
        foreach ($entry in @(Get-LegacyEntries (
            $backup
        ) 'Upgrade transaction backup' $true)) {
            if ($entryMap.ContainsKey($entry.Relative)) {
                Assert-EntriesEqual (
                    $entryMap[$entry.Relative]
                ) $entry 'Upgrade transaction backups'
            }
            else {
                $entryMap[$entry.Relative] = $entry
            }
        }
    }
    return @($entryMap.Values | Sort-Object @{
        Expression = { if ($_.IsDirectory) { 0 } else { 1 } }
    }, Relative)
}

function Restore-TransactionEntries {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$BackupEntries,

        [Parameter(Mandatory = $true)]
        [string]$TargetRoot
    )

    $targetEntries = @()
    if (Test-Path -LiteralPath $TargetRoot) {
        Assert-WhitelistLayout $TargetRoot 'Legacy restore target'
        $targetEntries = @(
            Get-LegacyEntries $TargetRoot 'Legacy restore target' $true
        )
    }
    Assert-RestoreCompatible $BackupEntries $targetEntries $TargetRoot
    if ($BackupEntries.Count -eq 0) {
        return
    }
    Ensure-SafeDirectory $TargetRoot 'Legacy restore target'
    Remove-InstallerTemps $TargetRoot 'Legacy restore target'
    $targetMap = Get-EntryMap $targetEntries
    foreach ($entry in $BackupEntries) {
        if (-not $entry.IsDirectory -or $targetMap.ContainsKey($entry.Relative)) {
            continue
        }
        Ensure-SafeDirectory (
            Get-ContainedPath $TargetRoot $entry.Relative
        ) 'Legacy restore target'
    }
    foreach ($entry in $BackupEntries) {
        if ($entry.IsDirectory -or $targetMap.ContainsKey($entry.Relative)) {
            continue
        }
        Copy-FileAtomically (
            $entry
        ) (Get-ContainedPath $TargetRoot $entry.Relative) 'Legacy restore target'
    }
    $finalTargetEntries = @(
        Get-LegacyEntries $TargetRoot 'Legacy restore target' $true
    )
    Assert-EntriesCovered $BackupEntries $finalTargetEntries 'Legacy restore target'
}

function Invoke-CommitUpgrade {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath,

        [Parameter(Mandatory = $true)]
        [string]$InstallScope
    )

    $targetRoot = Get-CanonicalRoot $TargetPath 'Upgrade target' $false
    $transactionsRoot = Get-TransactionRoot $RootPath $false
    if ($null -eq $transactionsRoot) {
        return
    }
    $transaction = Get-IncompleteTransaction $transactionsRoot
    if ($null -eq $transaction) {
        [void](Test-CompletedTransactionIdentity (
            $transactionsRoot
        ) $targetRoot $InstallScope)
        return
    }
    Assert-TransactionBaseIdentity (
        $transaction.Manifest
    ) $targetRoot $InstallScope
    if ([string]$transaction.Manifest.state -eq 'preserved') {
        Write-TransactionManifestState $transaction 'restoring'
    }
    if ([string]$transaction.Manifest.state -eq 'restoring') {
        Assert-TransactionBackups $transaction
        $restoreEntries = @(Get-RestoreEntriesFromTransaction $transaction)
        Restore-TransactionEntries $restoreEntries $targetRoot
        Restore-RuntimeArtifact (
            $transaction.Manifest
        ) $targetRoot 'Managed runtime restore'
        Write-TransactionManifestState $transaction 'restored'
    }
    if ([string]$transaction.Manifest.state -eq 'restored') {
        $restoreEntries = @(Get-RestoreEntriesFromTransaction $transaction)
        $targetEntries = @()
        if (Test-Path -LiteralPath $targetRoot) {
            $targetEntries = @(
                Get-LegacyEntries $targetRoot 'Legacy restore target' $true
            )
        }
        Assert-EntriesCovered $restoreEntries $targetEntries 'Legacy restore target'
        $runtimeSource = Get-ManifestRuntimeSource $transaction.Manifest
        if ($null -ne $runtimeSource) {
            Assert-RuntimeSnapshot (
                Get-ContainedPath $targetRoot (
                    [string]$runtimeSource.runtimeArtifact.relativePath
                )
            ) $runtimeSource.runtimeArtifact 'Managed runtime restore target'
        }
        Write-TransactionManifestState $transaction 'complete'
        return
    }
    if ([string]$transaction.Manifest.state -ne 'complete') {
        throw 'Upgrade transaction cannot be committed from its current state'
    }
}

function Invoke-RollbackUpgrade {
    param([string]$RootPath, [string]$TargetPath, [string]$InstallScope)
    $targetRoot = Get-CanonicalRoot $TargetPath 'Upgrade target' $false
    $transactionsRoot = Get-TransactionRoot $RootPath $false
    if ($null -eq $transactionsRoot) { return }
    $transaction = Get-IncompleteTransaction $transactionsRoot
    if ($null -eq $transaction) { return }
    Assert-TransactionBaseIdentity (
        $transaction.Manifest
    ) $targetRoot $InstallScope
    if (@('prepared', 'preserved') -notcontains [string]$transaction.Manifest.state) {
        throw 'Upgrade transaction cannot be rolled back from its current state'
    }
    $source = Get-ManifestRuntimeSource $transaction.Manifest
    if ($null -ne $source) {
        Restore-RuntimeArtifact (
            $transaction.Manifest
        ) ([string]$source.path) 'Managed runtime rollback'
    }
    if ([string]$transaction.Manifest.state -ne 'prepared') {
        Write-TransactionManifestState $transaction 'prepared'
    }
}

function Assert-PreserveCompatible {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$SourceEntries,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$BackupEntries,

        [Parameter(Mandatory = $true)]
        [string]$BackupRoot,

        [Parameter(Mandatory = $true)]
        [bool]$MarkerExists
    )

    $sourceMap = Get-EntryMap $SourceEntries
    $backupMap = Get-EntryMap $BackupEntries
    foreach ($sourceEntry in $SourceEntries) {
        if ($backupMap.ContainsKey($sourceEntry.Relative)) {
            Assert-EntriesEqual (
                $sourceEntry
            ) $backupMap[$sourceEntry.Relative] 'Legacy backup'
        }
        else {
            Assert-ParentDirectoryTypes (
                $BackupRoot
            ) $sourceEntry.Relative 'Legacy backup'
        }
    }

    if (-not $MarkerExists) {
        foreach ($backupEntry in $BackupEntries) {
            if (-not $sourceMap.ContainsKey($backupEntry.Relative)) {
                throw "Incomplete legacy backup contains stale data: $($backupEntry.Relative)"
            }
        }
    }
}

function Invoke-Preserve {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$BackupPath
    )

    $sourceRoot = Get-CanonicalRoot $SourcePath 'Legacy source' $true
    $backupRoot = Get-CanonicalRoot $BackupPath 'Legacy backup' $false
    Assert-SeparateRoots $sourceRoot $backupRoot
    Assert-WhitelistLayout $sourceRoot 'Legacy source'
    if (Test-Path -LiteralPath $backupRoot) {
        Assert-WhitelistLayout $backupRoot 'Legacy backup'
    }

    $sourceEntries = @(Get-LegacyEntries $sourceRoot 'Legacy source')
    $backupEntries = @()
    $markerExists = $false
    if (Test-Path -LiteralPath $backupRoot) {
        $markerExists = Test-PreservedMarker $backupRoot $false
        $backupEntries = @(
            Get-LegacyEntries $backupRoot 'Legacy backup' $true
        )
    }
    Assert-PreserveCompatible (
        $sourceEntries
    ) $backupEntries $backupRoot $markerExists

    Ensure-SafeDirectory $backupRoot 'Legacy backup'
    Remove-InstallerTemps $backupRoot 'Legacy backup'
    $backupMap = Get-EntryMap $backupEntries
    foreach ($sourceEntry in $sourceEntries) {
        if ($backupMap.ContainsKey($sourceEntry.Relative)) {
            continue
        }

        $destination = Get-ContainedPath $backupRoot $sourceEntry.Relative
        if ($sourceEntry.IsDirectory) {
            Ensure-SafeDirectory $destination 'Legacy backup'
        }
        else {
            Copy-FileAtomically $sourceEntry $destination 'Legacy backup'
        }
    }

    $finalSourceEntries = @(
        Get-LegacyEntries $sourceRoot 'Legacy source'
    )
    $finalBackupEntries = @(
        Get-LegacyEntries $backupRoot 'Legacy backup' $true
    )
    Assert-EntrySetsEqual (
        $sourceEntries
    ) $finalSourceEntries 'Legacy source'
    Assert-EntriesCovered (
        $finalSourceEntries
    ) $finalBackupEntries 'Legacy backup'
    Assert-EntriesCovered (
        $backupEntries
    ) $finalBackupEntries 'Legacy backup'
    if (-not $markerExists) {
        Assert-EntrySetsEqual (
            $finalSourceEntries
        ) $finalBackupEntries 'Legacy backup'
    }
    Write-PreservedMarker $backupRoot
}

function Assert-RestoreCompatible {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$BackupEntries,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$TargetEntries,

        [Parameter(Mandatory = $true)]
        [string]$TargetRoot
    )

    $targetMap = Get-EntryMap $TargetEntries
    foreach ($backupEntry in $BackupEntries) {
        if ($targetMap.ContainsKey($backupEntry.Relative)) {
            Assert-EntriesEqual (
                $backupEntry
            ) $targetMap[$backupEntry.Relative] 'Legacy restore target'
        }
        else {
            Assert-ParentDirectoryTypes (
                $TargetRoot
            ) $backupEntry.Relative 'Legacy restore target'
        }
    }
}

function Invoke-Restore {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BackupPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    $backupRoot = Get-CanonicalRoot $BackupPath 'Legacy backup' $true
    $targetRoot = Get-CanonicalRoot $TargetPath 'Legacy restore target' $false
    Assert-SeparateRoots $backupRoot $targetRoot
    Assert-WhitelistLayout $backupRoot 'Legacy backup'
    [void](Test-PreservedMarker $backupRoot $true)
    if (Test-Path -LiteralPath $targetRoot) {
        Assert-WhitelistLayout $targetRoot 'Legacy restore target'
    }

    $backupEntries = @(
        Get-LegacyEntries $backupRoot 'Legacy backup' $true
    )
    $targetEntries = @()
    if (Test-Path -LiteralPath $targetRoot) {
        $targetEntries = @(
            Get-LegacyEntries $targetRoot 'Legacy restore target' $true
        )
    }
    Assert-RestoreCompatible $backupEntries $targetEntries $targetRoot

    if ($backupEntries.Count -eq 0 -and -not (Test-Path -LiteralPath $targetRoot)) {
        return
    }
    Ensure-SafeDirectory $targetRoot 'Legacy restore target'
    Remove-InstallerTemps $targetRoot 'Legacy restore target'
    $targetMap = Get-EntryMap $targetEntries
    foreach ($backupEntry in $backupEntries) {
        if (
            -not $backupEntry.IsDirectory -or
            $targetMap.ContainsKey($backupEntry.Relative)
        ) {
            continue
        }
        $destination = Get-ContainedPath $targetRoot $backupEntry.Relative
        Ensure-SafeDirectory $destination 'Legacy restore target'
    }
    foreach ($backupEntry in $backupEntries) {
        if (
            $backupEntry.IsDirectory -or
            $targetMap.ContainsKey($backupEntry.Relative)
        ) {
            continue
        }
        $destination = Get-ContainedPath $targetRoot $backupEntry.Relative
        Copy-FileAtomically $backupEntry $destination 'Legacy restore target'
    }

    $finalBackupEntries = @(
        Get-LegacyEntries $backupRoot 'Legacy backup' $true
    )
    $finalTargetEntries = @(
        Get-LegacyEntries $targetRoot 'Legacy restore target' $true
    )
    Assert-EntrySetsEqual (
        $backupEntries
    ) $finalBackupEntries 'Legacy backup'
    [void](Test-PreservedMarker $backupRoot $true)
    Assert-EntriesCovered (
        $finalBackupEntries
    ) $finalTargetEntries 'Legacy restore target'
}

function Get-InstallDirectoryProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [Parameter(Mandatory = $true)]
        [int]$ExcludedId
    )

    $processes = @(
        Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Where-Object {
                $_.ProcessId -ne $ExcludedId -and
                -not [string]::IsNullOrWhiteSpace($_.ExecutablePath)
            }
    )
    $matches = New-Object System.Collections.ArrayList
    foreach ($process in $processes) {
        try {
            $executable = [IO.Path]::GetFullPath(
                [string]$process.ExecutablePath
            )
        }
        catch {
            throw "Cannot canonicalize process executable path for PID $($process.ProcessId)"
        }
        if (Test-IsSameOrDescendant $executable $InstallRoot) {
            [void]$matches.Add([pscustomobject]@{
                ProcessId = [int]$process.ProcessId
                ExecutablePath = $executable
            })
        }
    }
    return @($matches)
}

function Get-ProcessById {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    return @(
        Get-CimInstance -ClassName Win32_Process -Filter (
            "ProcessId = $ProcessId"
        ) -ErrorAction Stop
    )
}

function Assert-ProcessStillMatches {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [string]$InstallRoot
    )

    $current = @(Get-ProcessById $Expected.ProcessId)
    if ($current.Count -eq 0) {
        return $false
    }
    if ($current.Count -ne 1) {
        throw "Process query returned duplicate PID $($Expected.ProcessId)"
    }
    if ([string]::IsNullOrWhiteSpace($current[0].ExecutablePath)) {
        throw "Process executable path became unavailable for PID $($Expected.ProcessId)"
    }

    try {
        $currentPath = [IO.Path]::GetFullPath(
            [string]$current[0].ExecutablePath
        )
    }
    catch {
        throw "Cannot canonicalize process executable path for PID $($Expected.ProcessId)"
    }
    if (
        -not (Test-IsSameOrDescendant $currentPath $InstallRoot) -or
        -not [string]::Equals(
            $currentPath,
            $Expected.ExecutablePath,
            $script:PathComparison
        )
    ) {
        throw "Process identity changed before stop for PID $($Expected.ProcessId)"
    }
    return $true
}

function Request-GracefulProcessExit {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Process,

        [Parameter(Mandatory = $true)]
        [string]$InstallRoot
    )

    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (-not [IO.File]::Exists($taskkill)) {
        throw "taskkill.exe is unavailable: $taskkill"
    }
    $request = Start-Process -FilePath $taskkill -ArgumentList (
        '/PID ' + [string]$Process.ProcessId
    ) -Wait -PassThru -WindowStyle Hidden
    if ($request.ExitCode -ne 0) {
        $remaining = @(Get-ProcessById $Process.ProcessId)
        if ($remaining.Count -gt 0) {
            [void](Assert-ProcessStillMatches $Process $InstallRoot)
        }
    }
}

function Wait-ForGracefulProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,

        [Parameter(Mandatory = $true)]
        [int]$ExcludedId,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutable,

        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(
            Get-InstallDirectoryProcesses $InstallRoot $ExcludedId |
                Where-Object {
                    [string]::Equals(
                        $_.ExecutablePath,
                        $ExpectedExecutable,
                        $script:PathComparison
                    )
                }
        )
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
}

function Invoke-StopProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallPath,

        [Parameter(Mandatory = $true)]
        [int]$ExcludedId,

        [Parameter(Mandatory = $true)]
        [string]$GracefulName,

        [Parameter(Mandatory = $true)]
        [int]$GracefulTimeout
    )

    if ($ExcludedId -le 0) {
        throw 'ExcludedProcessId must be a positive process ID'
    }
    if (
        [string]::IsNullOrWhiteSpace($GracefulName) -or
        $GracefulName -ne [IO.Path]::GetFileName($GracefulName)
    ) {
        throw 'GracefulExecutableName must be a file name'
    }
    if ($GracefulTimeout -lt 0 -or $GracefulTimeout -gt 120) {
        throw 'GracefulTimeoutSeconds must be between 0 and 120'
    }
    $installRoot = Get-CanonicalRoot (
        $InstallPath
    ) 'Installation directory' $false

    $pathRoot = [IO.Path]::GetPathRoot($installRoot)
    $rootSeparators = [char[]]@(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    if ([string]::Equals(
        $installRoot.TrimEnd($rootSeparators),
        $pathRoot.TrimEnd($rootSeparators),
        $script:PathComparison
    )) {
        throw 'Installation directory must not be a drive root'
    }
    if (-not [IO.Directory]::Exists($installRoot)) {
        return
    }

    $gracefulExecutable = Get-ContainedPath $installRoot $GracefulName
    $graceful = @(
        Get-InstallDirectoryProcesses $installRoot $ExcludedId |
            Where-Object {
                [string]::Equals(
                    $_.ExecutablePath,
                    $gracefulExecutable,
                    $script:PathComparison
                )
            }
    )
    foreach ($process in $graceful) {
        if (Assert-ProcessStillMatches $process $installRoot) {
            Request-GracefulProcessExit $process $installRoot
        }
    }
    if ($graceful.Count -gt 0 -and $GracefulTimeout -gt 0) {
        Wait-ForGracefulProcesses (
            $installRoot
        ) $ExcludedId $gracefulExecutable $GracefulTimeout
    }

    $running = @(
        Get-InstallDirectoryProcesses $installRoot $ExcludedId
    )
    foreach ($process in $running) {
        if (Assert-ProcessStillMatches $process $installRoot) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
    }

    $emptyChecks = 0
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $remaining = @(
            Get-InstallDirectoryProcesses $installRoot $ExcludedId
        )
        if ($remaining.Count -eq 0) {
            $emptyChecks++
            if ($emptyChecks -ge 2) {
                return
            }
        }
        else {
            $emptyChecks = 0
            foreach ($process in $remaining) {
                if (Assert-ProcessStillMatches $process $installRoot) {
                    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }
    $ids = @($remaining | ForEach-Object { $_.ProcessId }) -join ', '
    throw "Processes are still running inside the installation directory: $ids"
}

try {
    switch ($Action) {
        'preserve' {
            if (
                -not $PSBoundParameters.ContainsKey('Source') -or
                [string]::IsNullOrWhiteSpace($Source)
            ) {
                throw 'Source is required for preserve'
            }
            if (
                -not $PSBoundParameters.ContainsKey('Backup') -or
                [string]::IsNullOrWhiteSpace($Backup)
            ) {
                throw 'Backup is required for preserve'
            }
            if ($PSBoundParameters.ContainsKey('Target')) {
                throw 'Target is not valid for preserve'
            }
            if (
                $PSBoundParameters.ContainsKey('TransactionRoot') -or
                $PSBoundParameters.ContainsKey('Scope') -or
                $PSBoundParameters.ContainsKey('HkcuSource') -or
                $PSBoundParameters.ContainsKey('HklmSource') -or
                $PSBoundParameters.ContainsKey('InstallDirectory') -or
                $PSBoundParameters.ContainsKey('ExcludedProcessId') -or
                $PSBoundParameters.ContainsKey('GracefulExecutableName') -or
                $PSBoundParameters.ContainsKey('GracefulTimeoutSeconds')
            ) {
                throw 'Process arguments are not valid for preserve'
            }
            Invoke-Preserve $Source $Backup
        }
        'restore' {
            if (
                -not $PSBoundParameters.ContainsKey('Target') -or
                [string]::IsNullOrWhiteSpace($Target)
            ) {
                throw 'Target is required for restore'
            }
            if (
                -not $PSBoundParameters.ContainsKey('Backup') -or
                [string]::IsNullOrWhiteSpace($Backup)
            ) {
                throw 'Backup is required for restore'
            }
            if ($PSBoundParameters.ContainsKey('Source')) {
                throw 'Source is not valid for restore'
            }
            if (
                $PSBoundParameters.ContainsKey('TransactionRoot') -or
                $PSBoundParameters.ContainsKey('Scope') -or
                $PSBoundParameters.ContainsKey('HkcuSource') -or
                $PSBoundParameters.ContainsKey('HklmSource') -or
                $PSBoundParameters.ContainsKey('InstallDirectory') -or
                $PSBoundParameters.ContainsKey('ExcludedProcessId') -or
                $PSBoundParameters.ContainsKey('GracefulExecutableName') -or
                $PSBoundParameters.ContainsKey('GracefulTimeoutSeconds')
            ) {
                throw 'Process arguments are not valid for restore'
            }
            Invoke-Restore $Backup $Target
        }
        'stop-processes' {
            if (
                -not $PSBoundParameters.ContainsKey('InstallDirectory') -or
                [string]::IsNullOrWhiteSpace($InstallDirectory)
            ) {
                throw 'InstallDirectory is required for stop-processes'
            }
            if (-not $PSBoundParameters.ContainsKey('ExcludedProcessId')) {
                throw 'ExcludedProcessId is required for stop-processes'
            }
            if (
                -not $PSBoundParameters.ContainsKey('GracefulExecutableName') -or
                [string]::IsNullOrWhiteSpace($GracefulExecutableName)
            ) {
                throw 'GracefulExecutableName is required for stop-processes'
            }
            if (-not $PSBoundParameters.ContainsKey('GracefulTimeoutSeconds')) {
                throw 'GracefulTimeoutSeconds is required for stop-processes'
            }
            foreach ($argumentName in @(
                'Source',
                'Backup',
                'Target',
                'TransactionRoot',
                'Scope',
                'HkcuSource',
                'HklmSource'
            )) {
                if ($PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is not valid for stop-processes"
                }
            }
            Invoke-StopProcesses (
                $InstallDirectory
            ) $ExcludedProcessId $GracefulExecutableName $GracefulTimeoutSeconds
        }
        'remove-managed-runtime' {
            if (
                -not $PSBoundParameters.ContainsKey('InstallDirectory') -or
                [string]::IsNullOrWhiteSpace($InstallDirectory)
            ) {
                throw 'InstallDirectory is required for remove-managed-runtime'
            }
            foreach ($argumentName in @(
                'Source',
                'Backup',
                'Target',
                'TransactionRoot',
                'Scope',
                'HkcuSource',
                'HklmSource',
                'ExcludedProcessId',
                'GracefulExecutableName',
                'GracefulTimeoutSeconds'
            )) {
                if ($PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is not valid for remove-managed-runtime"
                }
            }
            Remove-ManagedRuntime $InstallDirectory
        }
        'prepare-upgrade' {
            foreach ($argumentName in @('TransactionRoot', 'Target', 'Scope')) {
                if (
                    -not $PSBoundParameters.ContainsKey($argumentName) -or
                    [string]::IsNullOrWhiteSpace(
                        [string](Get-Variable -Name $argumentName -ValueOnly)
                    )
                ) {
                    throw "$argumentName is required for prepare-upgrade"
                }
            }
            foreach ($argumentName in @(
                'ExcludedProcessId',
                'GracefulExecutableName',
                'GracefulTimeoutSeconds'
            )) {
                if (-not $PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is required for prepare-upgrade"
                }
            }
            foreach ($argumentName in @('Source', 'Backup', 'InstallDirectory')) {
                if ($PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is not valid for prepare-upgrade"
                }
            }
            Invoke-PrepareUpgrade (
                $TransactionRoot
            ) $Target $Scope $HkcuSource $HklmSource (
                $ExcludedProcessId
            ) $GracefulExecutableName $GracefulTimeoutSeconds
        }
        'commit-upgrade' {
            foreach ($argumentName in @('TransactionRoot', 'Target', 'Scope')) {
                if (
                    -not $PSBoundParameters.ContainsKey($argumentName) -or
                    [string]::IsNullOrWhiteSpace(
                        [string](Get-Variable -Name $argumentName -ValueOnly)
                    )
                ) {
                    throw "$argumentName is required for commit-upgrade"
                }
            }
            foreach ($argumentName in @(
                'Source',
                'Backup',
                'InstallDirectory',
                'ExcludedProcessId',
                'GracefulExecutableName',
                'GracefulTimeoutSeconds',
                'HkcuSource',
                'HklmSource'
            )) {
                if ($PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is not valid for commit-upgrade"
                }
            }
            Invoke-CommitUpgrade (
                $TransactionRoot
            ) $Target $Scope
        }
        'rollback-upgrade' {
            foreach ($argumentName in @('TransactionRoot', 'Target', 'Scope')) {
                if (
                    -not $PSBoundParameters.ContainsKey($argumentName) -or
                    [string]::IsNullOrWhiteSpace(
                        [string](Get-Variable -Name $argumentName -ValueOnly)
                    )
                ) {
                    throw "$argumentName is required for rollback-upgrade"
                }
            }
            foreach ($argumentName in @(
                'Source',
                'Backup',
                'InstallDirectory',
                'ExcludedProcessId',
                'GracefulExecutableName',
                'GracefulTimeoutSeconds',
                'HkcuSource',
                'HklmSource'
            )) {
                if ($PSBoundParameters.ContainsKey($argumentName)) {
                    throw "$argumentName is not valid for rollback-upgrade"
                }
            }
            Invoke-RollbackUpgrade (
                $TransactionRoot
            ) $Target $Scope
        }
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
