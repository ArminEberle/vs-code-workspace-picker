@echo off
setlocal

set "BUMP_TYPE=%~1"
if "%BUMP_TYPE%"=="" set "BUMP_TYPE=patch"

set "BRANCH=%~2"
if "%BRANCH%"=="" set "BRANCH=main"

if /I not "%BUMP_TYPE%"=="patch" if /I not "%BUMP_TYPE%"=="minor" if /I not "%BUMP_TYPE%"=="major" (
  echo Usage: scripts\release.cmd [patch^|minor^|major] [branch]
  exit /b 1
)

git diff --quiet
if errorlevel 1 (
  echo Working tree is not clean. Commit or stash your changes before releasing.
  exit /b 1
)

git diff --cached --quiet
if errorlevel 1 (
  echo Working tree has staged changes. Commit or stash your changes before releasing.
  exit /b 1
)

echo Releasing a %BUMP_TYPE% version from branch '%BRANCH%'...
call npm version %BUMP_TYPE%
if errorlevel 1 exit /b 1

git push origin %BRANCH% --follow-tags
if errorlevel 1 exit /b 1

echo Release pushed. GitHub Actions should now build, tag, and publish the release.
