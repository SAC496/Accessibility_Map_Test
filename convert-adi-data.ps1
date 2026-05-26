# Converts Neighborhood Atlas ADI 9-digit ZIP CSVs into adi-data.js
# Run: powershell -ExecutionPolicy Bypass -File convert-adi-data.ps1

$files = @{
    pittsburgh = "C:\Users\Sam\Documents\Accessibility_Map_Test\data\PA_2023_ADI_9 Digit Zip Code_v4_0_1.csv"
    seattle    = "C:\Users\Sam\Documents\Accessibility_Map_Test\data\WA_2023_ADI_9 Digit Zip Code_v4_0_1.csv"
}

$result = @{}

foreach ($city in $files.Keys) {
    $path = $files[$city]
    Write-Host "Processing $city ($path)..."

    $zipTotals = @{}   # zip5 -> [sum, count]

    $reader = [System.IO.StreamReader]::new($path)
    $header = $reader.ReadLine()  # skip header

    $lineNum = 0
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        $lineNum++
        if ($lineNum % 250000 -eq 0) { Write-Host "  $lineNum rows..." }

        # CSV fields: "",ZIP_4,TYPE,GISJOIN,FIPS,ADI_NATRANK,ADI_STATERNK
        # Fields may be quoted. Split by comma and strip quotes.
        $parts = $line.Split(',')
        if ($parts.Length -lt 7) { continue }

        $type    = $parts[2].Trim('"', ' ')
        $staternk = $parts[6].Trim('"', ' ')

        # Only use regular residential entries with valid numeric rank
        if ($type -ne 'NA') { continue }
        if (-not ($staternk -match '^\d+$')) { continue }

        $rank = [int]$staternk
        if ($rank -lt 1 -or $rank -gt 10) { continue }

        # Extract 5-digit ZIP from the 9-digit ZIP_4
        $zip9 = $parts[1].Trim('"', ' ')
        if ($zip9.Length -lt 5) { continue }
        $zip5 = $zip9.Substring(0, 5).PadLeft(5, '0')

        if (-not $zipTotals.ContainsKey($zip5)) {
            $zipTotals[$zip5] = @(0, 0)
        }
        $zipTotals[$zip5][0] += $rank
        $zipTotals[$zip5][1]++
    }
    $reader.Close()

    Write-Host "  Found $($zipTotals.Count) unique 5-digit ZIPs"
    $result[$city] = $zipTotals
}

# Build JS output
$sb = [System.Text.StringBuilder]::new()
$null = $sb.AppendLine("// Neighborhood Atlas ADI State Rankings 2023 (aggregated to 5-digit ZIP)")
$null = $sb.AppendLine("// ADI state rank 1 = least disadvantaged, 10 = most disadvantaged")
$null = $sb.AppendLine("// Source: neighborhoodatlas.medicine.wisc.edu")
$null = $sb.AppendLine("window.ADI_DATA = {")

$cityNames = @($result.Keys)
for ($ci = 0; $ci -lt $cityNames.Count; $ci++) {
    $city = $cityNames[$ci]
    $zipTotals = $result[$city]
    $null = $sb.AppendLine("  ${city}: {")

    $zips = @($zipTotals.Keys | Sort-Object)
    for ($i = 0; $i -lt $zips.Count; $i++) {
        $z = $zips[$i]
        $sum   = $zipTotals[$z][0]
        $count = $zipTotals[$z][1]
        $avg   = [math]::Round($sum / $count, 2)
        $comma = if ($i -lt $zips.Count - 1) { "," } else { "" }
        $null = $sb.AppendLine("    `"$z`": { avg: $avg, n: $count }$comma")
    }

    $cityComma = if ($ci -lt $cityNames.Count - 1) { "," } else { "" }
    $null = $sb.AppendLine("  }$cityComma")
}

$null = $sb.AppendLine("};")

$outPath = "C:\Users\Sam\Documents\Accessibility_Map_Test\adi-data.js"
[System.IO.File]::WriteAllText($outPath, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Host "Written to $outPath"
Write-Host "Done."
