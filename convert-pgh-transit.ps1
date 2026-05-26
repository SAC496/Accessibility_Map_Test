# Pre-generates pgh-extra-transit.js from GTFS feeds for Pittsburgh regional agencies
# Agencies: WCTA, BCTA, NCATA, MMVTA
# Run: powershell -ExecutionPolicy Bypass -File convert-pgh-transit.ps1

Add-Type -AssemblyName System.IO.Compression.FileSystem

$agencies = @(
    @{ name = 'WCTA';  url = 'https://wcta.rideralerts.com/InfoPoint/gtfs-zip.ashx' },
    @{ name = 'BCTA';  url = 'https://bcta.rideralerts.com/infopoint/gtfs-zip.ashx' },
    @{ name = 'NCATA'; url = 'https://ncata.rideralerts.com/InfoPoint/gtfs-zip.ashx' },
    @{ name = 'MMVTA'; url = 'https://mmvta.rideralerts.com/InfoPoint/gtfs-zip.ashx' }
)

function Read-ZipEntry($zip, $name) {
    $entry = $zip.Entries | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $entry) { return $null }
    $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)
    $content = $reader.ReadToEnd()
    $reader.Close()
    return $content
}

function Parse-CSV($text) {
    if (-not $text) { return @(), @{} }
    $lines = $text -split "`r?`n" | Where-Object { $_ -ne '' }
    $header = $lines[0].Split(',') | ForEach-Object { $_.Trim('"', ' ') }
    $idx = @{}
    for ($i = 0; $i -lt $header.Count; $i++) { $idx[$header[$i]] = $i }
    return $lines[1..($lines.Count-1)], $idx
}

# All stops across all agencies: stop_key (agency+stop_id) -> {lat, lon, routes: Set}
$allStops = @{}

foreach ($agency in $agencies) {
    Write-Host "Processing $($agency.name)..."

    $tmpZip = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "$($agency.name).zip")
    try {
        Invoke-WebRequest -Uri $agency.url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 60
    } catch {
        Write-Host "  FAILED to download: $_"
        continue
    }

    $zip = $null
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($tmpZip)

        # --- stops.txt ---
        $stopsText = Read-ZipEntry $zip 'stops.txt'
        $stopsLines, $stopsIdx = Parse-CSV $stopsText
        $stopData = @{}  # stop_id -> {lat, lon}
        foreach ($line in $stopsLines) {
            $cols = $line.Split(',')
            $sid  = $cols[$stopsIdx['stop_id']].Trim('"', ' ')
            $lat  = $cols[$stopsIdx['stop_lat']].Trim('"', ' ')
            $lon  = $cols[$stopsIdx['stop_lon']].Trim('"', ' ')
            if ($sid -and $lat -and $lon) {
                $stopData[$sid] = @{ lat = $lat; lon = $lon }
            }
        }
        Write-Host "  stops: $($stopData.Count)"

        # --- trips.txt: trip_id -> route_id ---
        $tripsText = Read-ZipEntry $zip 'trips.txt'
        $tripsLines, $tripsIdx = Parse-CSV $tripsText
        $tripToRoute = @{}
        foreach ($line in $tripsLines) {
            $cols = $line.Split(',')
            $tid  = $cols[$tripsIdx['trip_id']].Trim('"', ' ')
            $rid  = $cols[$tripsIdx['route_id']].Trim('"', ' ')
            if ($tid -and $rid) { $tripToRoute[$tid] = $rid }
        }
        Write-Host "  trips: $($tripToRoute.Count)"

        # --- stop_times.txt: stop_id -> Set<route_id> via trip_id ---
        $stEntry = $zip.Entries | Where-Object { $_.Name -eq 'stop_times.txt' } | Select-Object -First 1
        $stReader = [System.IO.StreamReader]::new($stEntry.Open(), [System.Text.Encoding]::UTF8)
        $stHeader = $stReader.ReadLine().Split(',') | ForEach-Object { $_.Trim('"', ' ') }
        $stTripIdx = [Array]::IndexOf($stHeader, 'trip_id')
        $stStopIdx = [Array]::IndexOf($stHeader, 'stop_id')

        $stopRoutes = @{}  # stop_id -> HashSet<route_id>
        $stLines = 0
        while (-not $stReader.EndOfStream) {
            $line = $stReader.ReadLine()
            $stLines++
            $cols = $line.Split(',')
            $tid  = $cols[$stTripIdx].Trim('"', ' ')
            $sid  = $cols[$stStopIdx].Trim('"', ' ')
            $rid  = $tripToRoute[$tid]
            if ($rid -and $stopData.ContainsKey($sid)) {
                if (-not $stopRoutes.ContainsKey($sid)) {
                    $stopRoutes[$sid] = [System.Collections.Generic.HashSet[string]]::new()
                }
                $null = $stopRoutes[$sid].Add("$($agency.name):$rid")
            }
        }
        $stReader.Close()
        Write-Host "  stop_times rows: $stLines"

        # Merge into allStops
        foreach ($sid in $stopRoutes.Keys) {
            if (-not $stopData.ContainsKey($sid)) { continue }
            $key = "$($agency.name):$sid"
            $allStops[$key] = @{
                lat    = $stopData[$sid].lat
                lon    = $stopData[$sid].lon
                routes = $stopRoutes[$sid]
            }
        }
        Write-Host "  merged stops with routes: $($stopRoutes.Count)"

    } catch {
        Write-Host "  ERROR: $_"
    } finally {
        if ($zip) { $zip.Dispose() }
        if (Test-Path $tmpZip) { Remove-Item $tmpZip }
    }
}

Write-Host "`nTotal stops across all agencies: $($allStops.Count)"

# Write JS output
$sb = [System.Text.StringBuilder]::new()
$null = $sb.AppendLine("// Pittsburgh regional transit stops: WCTA, BCTA, NCATA, MMVTA")
$null = $sb.AppendLine("// Generated from GTFS feeds - run convert-pgh-transit.ps1 to refresh")
$null = $sb.AppendLine("// Format: [lat, lon, 'route1,route2,...']")
$null = $sb.AppendLine("window.PGH_EXTRA_TRANSIT = [")

$keys = @($allStops.Keys)
for ($i = 0; $i -lt $keys.Count; $i++) {
    $s = $allStops[$keys[$i]]
    $routeStr = ($s.routes | Sort-Object) -join ','
    $comma = if ($i -lt $keys.Count - 1) { ',' } else { '' }
    $null = $sb.AppendLine("  [$($s.lat),$($s.lon),`"$routeStr`"]$comma")
}

$null = $sb.AppendLine("];")

$outPath = "C:\Users\Sam\Documents\Accessibility_Map_Test\pgh-extra-transit.js"
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Host "Written to $outPath"
Write-Host "Done."
