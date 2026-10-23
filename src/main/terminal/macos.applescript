-- Only select an existing tab whose TTY belongs to the resolved agent process.
on run argv
  set targetTTY to item 1 of argv
  if application "Terminal" is not running then return "NOT_FOUND"
  tell application "Terminal"
    repeat with targetWindow in windows
      repeat with targetTab in tabs of targetWindow
        if tty of targetTab is targetTTY then
          set selected tab of targetWindow to targetTab
          set miniaturized of targetWindow to false
          set index of targetWindow to 1
          activate
          return "FOCUSED"
        end if
      end repeat
    end repeat
  end tell
  return "NOT_FOUND"
end run
