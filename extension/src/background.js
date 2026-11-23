const terminalURL = chrome.runtime.getURL('terminal.html');

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-terminal-tab') {
    await chrome.tabs.create({ url: terminalURL });
  }
});
