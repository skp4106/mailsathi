class MailMindBackground {
    constructor() {
        this.init();
    }

    init() {
        this.setupInstallListener();
        this.setupTabUpdateListener();
        this.setupMessageListener();
        console.log('MailMind background script initialized');
    }

    setupInstallListener() {
        chrome.runtime.onInstalled.addListener((details) => {
            if (details.reason === 'install') {
                this.handleFirstInstall();
            } else if (details.reason === 'update') {
                this.handleUpdate(details.previousVersion);
            }
        });
    }

    async handleFirstInstall() {
        console.log('MailMind extension installed');
        
        // Set default settings
        await chrome.storage.local.set({
            firstRun: true,
            replyTone: 'professional',
            summaryLength: 'short',
            autoInjectReplies: true
        });

        // Open welcome page or show notification
        this.showWelcomeNotification();
    }

    async handleUpdate(previousVersion) {
        console.log(`MailMind updated from ${previousVersion}`);
        
        // Handle any migration logic here
        // For example, updating storage schema or clearing old data
    }

    showWelcomeNotification() {
        chrome.notifications?.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'MailMind Extension Installed',
            message: 'Click the extension icon to set up your Gemini API key and start summarizing emails!'
        });
    }

    setupTabUpdateListener() {
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            // Check if user navigated to Gmail
            if (changeInfo.status === 'complete' && 
                tab.url && 
                tab.url.includes('mail.google.com')) {
                this.handleGmailTabReady(tabId);
            }
        });
    }

    async handleGmailTabReady(tabId) {
        try {
            // Inject content script if not already injected
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
        } catch (error) {
            // Content script might already be injected, ignore error
            console.log('Content script injection skipped:', error.message);
        }
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.action) {
                case 'getApiKey':
                    this.handleGetApiKey(sendResponse);
                    return true;
                
                case 'saveApiKey':
                    this.handleSaveApiKey(request.apiKey, sendResponse);
                    return true;
                
                case 'testApiConnection':
                    this.handleTestApiConnection(request.apiKey, sendResponse);
                    return true;
                
                case 'updateSettings':
                    this.handleUpdateSettings(request.settings, sendResponse);
                    return true;
                
                case 'getSettings':
                    this.handleGetSettings(sendResponse);
                    return true;
                
                default:
                    console.log('Unknown action:', request.action);
            }
        });
    }

    async handleGetApiKey(sendResponse) {
        try {
            const result = await chrome.storage.local.get(['geminiApiKey']);
            sendResponse({ apiKey: result.geminiApiKey || null });
        } catch (error) {
            sendResponse({ error: error.message });
        }
    }

    async handleSaveApiKey(apiKey, sendResponse) {
        try {
            await chrome.storage.local.set({ geminiApiKey: apiKey });
            sendResponse({ success: true });
        } catch (error) {
            sendResponse({ error: error.message });
        }
    }

    async handleTestApiConnection(apiKey, sendResponse) {
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: 'Test connection'
                        }]
                    }]
                })
            });
            
            sendResponse({ isValid: response.ok });
        } catch (error) {
            sendResponse({ isValid: false, error: error.message });
        }
    }

    async handleUpdateSettings(settings, sendResponse) {
        try {
            await chrome.storage.local.set(settings);
            sendResponse({ success: true });
        } catch (error) {
            sendResponse({ error: error.message });
        }
    }

    async handleGetSettings(sendResponse) {
        try {
            const defaultSettings = {
                replyTone: 'professional',
                summaryLength: 'short',
                autoInjectReplies: true,
                maxEmailsToSummarize: 10
            };
            
            const result = await chrome.storage.local.get(defaultSettings);
            sendResponse({ settings: result });
        } catch (error) {
            sendResponse({ error: error.message });
        }
    }

    // Utility method to check if Gmail tab is active
    async isGmailTabActive() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return tab && tab.url && tab.url.includes('mail.google.com');
        } catch (error) {
            return false;
        }
    }

    // Method to update extension badge
    async updateBadge(text = '', color = '#4299e1') {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await chrome.action.setBadgeText({ text, tabId: tab.id });
                await chrome.action.setBadgeBackgroundColor({ color, tabId: tab.id });
            }
        } catch (error) {
            console.error('Error updating badge:', error);
        }
    }

    // Method to handle errors and show notifications
    async showErrorNotification(title, message) {
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: title,
                message: message
            });
        } catch (error) {
            console.error('Error showing notification:', error);
        }
    }
}

// Initialize the background script
new MailMindBackground();