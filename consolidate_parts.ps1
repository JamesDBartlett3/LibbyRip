$list = @(gci -Directory | % { if ($_ | gci -Directory -Filter metadata) { return $_ } });
$list | % { Set-Location -LiteralPath $_.Name; (gci -Filter Part*.mp3).Name | % { "file '$_'" | Out-File -Append tracks.txt }; ffmpeg -f concat -safe 0 -i .\tracks.txt -c copy "out.mp3"; ffmpeg -y -i "out.mp3" -i .\metadata\cover.jpg -map 0:a -map 1:v -metadata:s:v comment="Cover (front)" -id3v2_version 3 -c:a copy "$((Get-Location).Path | Split-Path -Leaf).mp3"; "out.mp3", "tracks.txt" | Remove-Item; Set-Location .. };

## Run this code to delete the original files after consolidation. Automatically navigates into each directory and removes the Part*.mp3 files.
# $list | % { Set-Location -LiteralPath $_.Name; (gci -Filter Part*.mp3).Name | Remove-Item; Set-Location .. }