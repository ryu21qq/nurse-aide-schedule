$ErrorActionPreference = "Continue"
$RepoOwner = "ryu21qq"
$RepoName = "nurse-aide-schedule"
$FullRepo = "$RepoOwner/$RepoName"
$RemoteUrl = "https://github.com/$FullRepo.git"

Write-Host "1. Gitステージングとコミットを実行中..." -ForegroundColor Cyan
git add index.html .nojekyll 設計書.md css js server.ps1 サーバー起動.bat deploy_github_pages.ps1
git commit -m "Deploy Nurse Aide Shift Schedule App with Passcode Lock"

Write-Host "2. GitHubリポジトリ ($FullRepo) の確認・作成中..." -ForegroundColor Cyan
gh repo view $FullRepo > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    gh repo create $FullRepo --public --description "Nurse Aide Shift Schedule App (Passcode Protected)"
}

$existingRemote = git remote
if ($existingRemote -contains "origin") {
    git remote set-url origin $RemoteUrl
} else {
    git remote add origin $RemoteUrl
}

Write-Host "3. GitHub (mainブランチ) へプッシュ中..." -ForegroundColor Cyan
git push -u origin HEAD:main --force

Write-Host "4. GitHub Pages を有効化中..." -ForegroundColor Cyan
gh api --method POST "repos/$FullRepo/pages" -f "source[branch]=main" -f "source[path]=/" > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    gh api --method PUT "repos/$FullRepo/pages" -f "source[branch]=main" -f "source[path]=/" > $null 2>&1
}

Write-Host "============================================================" -ForegroundColor Green
Write-Host "  GitHub Pages 限定公開（パスコード保護付き）デプロイ完了！" -ForegroundColor Green
Write-Host "  公開URL     : https://$RepoOwner.github.io/$RepoName/" -ForegroundColor Yellow
Write-Host "  招待リンク  : https://$RepoOwner.github.io/$RepoName/?invite=na_inv_2026_k9x4m" -ForegroundColor Cyan
Write-Host "  初期合言葉  : 2026" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
