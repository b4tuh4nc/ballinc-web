# Sync latest scores, confirmed dates, and standings from FotMob API into web/data/*.json
param(
    [string]$DataDir = "$PSScriptRoot\web\data"
)

$ErrorActionPreference = "Continue"

$leagueMap = [ordered]@{
    "TSL"        = 71
    "EPL"        = 47
    "La_Liga"    = 87
    "Serie_A"    = 55
    "Bundesliga" = 54
    "Ligue_1"    = 53
    "UCL"        = 42
    "UEL"        = 73
    "UECL"       = 10216
    "NED"        = 57
    "POR"        = 61
    "BEL"        = 40
    "GRE"        = 59
    "DEN"        = 46
    "AUT"        = 45
    "SUI"        = 58
    "POL"        = 60
    "SCO"        = 64
    "CRO"        = 5093
    "CZE"        = 5092
}

$now = (Get-Date).ToUniversalTime()
$tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Turkey Standard Time")

Write-Host "Starting FotMob data sync for Ballinc..."
Write-Host "Current UTC time: $($now.ToString('o'))"

$headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    "Accept" = "application/json"
}

$updatedLeagues = 0
$totalMatchesMoved = 0

foreach ($code in $leagueMap.Keys) {
    $filePath = Join-Path $DataDir "$code.json"
    if (-not (Test-Path $filePath)) {
        continue
    }

    $id = $leagueMap[$code]
    Write-Host "Fetching $code (FotMob ID $id)..." -NoNewline

    try {
        $url = "https://www.fotmob.com/api/data/leagues?id=$id&season=2026%2F2027"
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 15
    } catch {
        Write-Host " FAILED to fetch FotMob: $_" -ForegroundColor Yellow
        continue
    }

    $allFmMatches = $resp.fixtures.allMatches
    if (-not $allFmMatches -or $allFmMatches.Count -eq 0) {
        Write-Host " No fixtures found on FotMob."
        continue
    }

    $rawJson = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8)
    $leagueData = $rawJson | ConvertFrom-Json

    # Index FotMob matches by "homeId|awayId"
    $fmByTeams = @{}
    foreach ($m in $allFmMatches) {
        $key = "$($m.home.id)|$($m.away.id)"
        $fmByTeams[$key] = $m
    }

    $existingResultIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($r in $leagueData.results) {
        if ($r.id) { [void]$existingResultIds.Add($r.id) }
    }

    $newMatches = [System.Collections.ArrayList]::new()
    $newResults = [System.Collections.ArrayList]::new($leagueData.results)
    $movedCount = 0

    foreach ($match in $leagueData.matches) {
        $hId = $match.home.fm
        $aId = $match.away.fm
        if (-not $hId -and $match.home.id -match "^fm(\d+)$") { $hId = $Matches[1] }
        if (-not $aId -and $match.away.id -match "^fm(\d+)$") { $aId = $Matches[1] }

        $key = "$hId|$aId"
        $fmMatch = if ($fmByTeams.ContainsKey($key)) { $fmByTeams[$key] } else { $null }

        $isFinished = $false
        $scoreArr = $null

        if ($fmMatch) {
            # Update kickoff if FotMob has confirmed utcTime
            if ($fmMatch.status.utcTime) {
                $match.kickoff = ([datetime]$fmMatch.status.utcTime).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            }

            if ($fmMatch.status.finished -eq $true -and $fmMatch.status.scoreStr -match "^\s*(\d+)\s*-\s*(\d+)\s*$") {
                $isFinished = $true
                $scoreArr = @([int]$Matches[1], [int]$Matches[2])
            }
        }

        # Check if match time is within 7 days -> set time_confirmed = true
        $matchDt = [datetime]$match.kickoff
        $diffDays = ($matchDt - $now).TotalDays
        if ($diffDays -le 7) {
            $match.time_confirmed = $true
        }

        if ($isFinished) {
            # Move to results
            if (-not $existingResultIds.Contains($match.id)) {
                $resObj = [PSCustomObject]@{
                    forecast = $null
                    id = $match.id
                    kickoff = $match.kickoff
                    round = $match.round
                    home = [PSCustomObject]@{
                        id = $match.home.id
                        name = $match.home.name
                        short = $match.home.short
                        fm = $hId
                    }
                    away = [PSCustomObject]@{
                        id = $match.away.id
                        name = $match.away.name
                        short = $match.away.short
                        fm = $aId
                    }
                    score = $scoreArr
                    xg = $null
                    markets = $match.markets
                    lambdas = $match.lambdas
                    scenario = $match.scenario
                    top_scores = $match.top_scores
                }

                if ($match.markets -and $match.markets.result) {
                    $probs = $match.markets.result
                    $pick = 0
                    if ($probs[1] -gt $probs[$pick]) { $pick = 1 }
                    if ($probs[2] -gt $probs[$pick]) { $pick = 2 }

                    $actual = if ($scoreArr[0] -gt $scoreArr[1]) { 0 } elseif ($scoreArr[0] -eq $scoreArr[1]) { 1 } else { 2 }
                    $hit = ($pick -eq $actual)

                    $resObj.forecast = [PSCustomObject]@{
                        probs = $probs
                        pick = $pick
                        hit = $hit
                    }
                }

                [void]$newResults.Add($resObj)
                [void]$existingResultIds.Add($match.id)
                $movedCount++
            }
        } else {
            [void]$newMatches.Add($match)
        }
    }

    # Sort results descending by kickoff
    $sortedResults = $newResults | Sort-Object { [datetime]$_.kickoff } -Descending
    # Sort matches ascending by kickoff
    $sortedMatches = $newMatches | Sort-Object { [datetime]$_.kickoff }

    # Recalculate Standings from all results
    $tableMap = @{}
    foreach ($r in $sortedResults) {
        $hTeam = $r.home.name
        $aTeam = $r.away.name
        $hId = $r.home.id
        $aId = $r.away.id
        $hShort = $r.home.short
        $aShort = $r.away.short

        foreach ($tInfo in @(
            @{ Id = $hId; Team = $hTeam; Short = $hShort; Gf = $r.score[0]; Ga = $r.score[1]; IsHome = $true; Date = [datetime]$r.kickoff },
            @{ Id = $aId; Team = $aTeam; Short = $aShort; Gf = $r.score[1]; Ga = $r.score[0]; IsHome = $false; Date = [datetime]$r.kickoff }
        )) {
            if (-not $tableMap.ContainsKey($tInfo.Id)) {
                $tableMap[$tInfo.Id] = [PSCustomObject]@{
                    team_id = $tInfo.Id
                    team = $tInfo.Team
                    short = $tInfo.Short
                    played = 0
                    w = 0
                    d = 0
                    l = 0
                    gf = 0
                    ga = 0
                    gd = 0
                    points = 0
                    xgf = $null
                    xga = $null
                    _matches = [System.Collections.ArrayList]::new()
                }
            }
            $entry = $tableMap[$tInfo.Id]
            $entry.played++
            $entry.gf += $tInfo.Gf
            $entry.ga += $tInfo.Ga
            $entry.gd = $entry.gf - $entry.ga

            $outcome = if ($tInfo.Gf -gt $tInfo.Ga) { "G" } elseif ($tInfo.Gf -eq $tInfo.Ga) { "B" } else { "M" }
            if ($outcome -eq "G") { $entry.w++; $entry.points += 3 }
            elseif ($outcome -eq "B") { $entry.d++; $entry.points += 1 }
            else { $entry.l++ }

            [void]$entry._matches.Add([PSCustomObject]@{ Date = $tInfo.Date; Outcome = $outcome })
        }
    }

    $sortedStandings = $tableMap.Values | Sort-Object `
        @{ Expression = { $_.points }; Descending = $true }, `
        @{ Expression = { $_.gd }; Descending = $true }, `
        @{ Expression = { $_.gf }; Descending = $true }

    $rank = 1
    $finalStandings = [System.Collections.ArrayList]::new()
    foreach ($row in $sortedStandings) {
        $sortedMatchList = $row._matches | Sort-Object { $_.Date }
        $form = if ($sortedMatchList.Count -ge 5) {
            $sortedMatchList[($sortedMatchList.Count - 5)..($sortedMatchList.Count - 1)] | ForEach-Object { $_.Outcome }
        } else {
            $sortedMatchList | ForEach-Object { $_.Outcome }
        }

        $rowObj = [PSCustomObject]@{
            team_id = $row.team_id
            team = $row.team
            short = $row.short
            played = $row.played
            w = $row.w
            d = $row.d
            l = $row.l
            gf = $row.gf
            ga = $row.ga
            gd = $row.gd
            points = $row.points
            xgf = $null
            xga = $null
            form = @($form)
            rank = $rank
        }
        [void]$finalStandings.Add($rowObj)
        $rank++
    }

    $leagueData.matches = @($sortedMatches)
    $leagueData.results = @($sortedResults)
    if ($finalStandings.Count -gt 0) {
        $leagueData.standings = @($finalStandings)
    }

    $newJson = $leagueData | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($filePath, $newJson, [System.Text.Encoding]::UTF8)

    Write-Host " Done! (Moved $movedCount finished matches to results, $($sortedMatches.Count) upcoming left)" -ForegroundColor Green
    $updatedLeagues++
    $totalMatchesMoved += $movedCount
}

# Rebuild index.json
Write-Host "Rebuilding web/data/index.json..."
$indexDays = @{}
$totalUpcoming = 0

foreach ($code in $leagueMap.Keys) {
    $filePath = Join-Path $DataDir "$code.json"
    if (-not (Test-Path $filePath)) { continue }

    $json = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    
    # Upcoming matches
    foreach ($m in $json.matches) {
        if (-not $m.kickoff) { continue }
        $dtParsed = [DateTime]::Parse($m.kickoff, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        $dtUtc = [DateTime]::SpecifyKind($dtParsed, [DateTimeKind]::Utc)
        $dtTr = [System.TimeZoneInfo]::ConvertTimeFromUtc($dtUtc, $tz)
        $dayKey = $dtTr.ToString("yyyy-MM-dd")

        if (-not $indexDays.ContainsKey($dayKey)) { $indexDays[$dayKey] = @{} }
        if (-not $indexDays[$dayKey].ContainsKey($code)) { $indexDays[$dayKey][$code] = 0 }
        $indexDays[$dayKey][$code]++
        $totalUpcoming++
    }

    # Recent results (past 7 days)
    $cutoff = $now.AddDays(-7)
    foreach ($r in $json.results) {
        if (-not $r.kickoff) { continue }
        $dtParsed = [DateTime]::Parse($r.kickoff, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        $dtUtc = [DateTime]::SpecifyKind($dtParsed, [DateTimeKind]::Utc)
        if ($dtUtc -ge $cutoff) {
            $dtTr = [System.TimeZoneInfo]::ConvertTimeFromUtc($dtUtc, $tz)
            $dayKey = $dtTr.ToString("yyyy-MM-dd")

            if (-not $indexDays.ContainsKey($dayKey)) { $indexDays[$dayKey] = @{} }
            if (-not $indexDays[$dayKey].ContainsKey($code)) { $indexDays[$dayKey][$code] = 0 }
            $indexDays[$dayKey][$code]++
        }
    }
}

# Sort days
$sortedDayKeys = $indexDays.Keys | Sort-Object
$orderedDays = [ordered]@{}
foreach ($k in $sortedDayKeys) {
    $orderedDays[$k] = $indexDays[$k]
}

$newIndex = [PSCustomObject]@{
    days = $orderedDays
    total = $totalUpcoming
}
$indexJson = $newIndex | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $DataDir "index.json"), $indexJson, [System.Text.Encoding]::UTF8)

# Update meta.json
$metaPath = Join-Path $DataDir "meta.json"
if (Test-Path $metaPath) {
    $metaJson = [System.IO.File]::ReadAllText($metaPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $metaJson.generated_at = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $newMeta = $metaJson | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($metaPath, $newMeta, [System.Text.Encoding]::UTF8)
}

Write-Host "================================================="
Write-Host "Sync Complete!" -ForegroundColor Green
Write-Host "Updated leagues: $updatedLeagues"
Write-Host "Total matches moved to results: $totalMatchesMoved"
Write-Host "index.json and meta.json successfully refreshed!"
Write-Host "================================================="
