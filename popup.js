class MailMindPopup {
    constructor() {
        this.apiKey = null;
        this.isLoading = false;
        this.init();
    }

    async init() {
        try {
            await this.loadApiKey();
            this.setupEventListeners();
            await this.checkGmailTab();
            // Auto-load email count on popup open
            if (this.apiKey) {
                this.loadEmailCount();
            }
        } catch (error) {
            console.error('MailMind: Failed to initialize popup:', error);
            this.showError('Failed to initialize extension: ' + error.message);
        }
    }

    async loadApiKey() {
        try {
            const result = await chrome.storage.local.get(['geminiApiKey']);
            this.apiKey = result.geminiApiKey;
            
            if (!this.apiKey) {
                this.showApiSetup();
            } else {
                this.showMainContent();
            }
        } catch (error) {
            console.error('Error loading API key:', error);
            this.showError('Failed to load API key');
        }
    }

    setupEventListeners() {
        document.getElementById('settingsBtn').addEventListener('click', () => {
            this.toggleApiSetup();
        });

        document.getElementById('saveApiKey').addEventListener('click', () => {
            this.saveApiKey();
        });

        // Enter key support for API key input
        document.getElementById('apiKey').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveApiKey();
            }
        });
    }

    showApiSetup() {
        document.getElementById('apiSetup').style.display = 'block';
        document.getElementById('mainContent').style.display = 'none';
    }

    showMainContent() {
        document.getElementById('apiSetup').style.display = 'none';
        document.getElementById('mainContent').style.display = 'block';
    }

    toggleApiSetup() {
        const apiSetup = document.getElementById('apiSetup');
        if (apiSetup.style.display === 'none') {
            this.showApiSetup();
            document.getElementById('apiKey').value = this.apiKey || '';
        } else {
            this.showMainContent();
        }
    }

    async saveApiKey() {
        const apiKeyInput = document.getElementById('apiKey');
        const apiKey = apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showError('Please enter a valid API key');
            return;
        }

        // Show loading state while testing
        const saveButton = document.getElementById('saveApiKey');
        const originalText = saveButton.textContent;
        saveButton.textContent = 'Testing...';
        saveButton.disabled = true;

        try {
            // Test the API key
            const isValid = await this.testApiKey(apiKey);
            if (isValid) {
                this.apiKey = apiKey;
                await chrome.storage.local.set({ geminiApiKey: apiKey });
                this.hideError();
                this.showMainContent();
                // Auto-load email count after successful API key setup
                setTimeout(() => this.loadEmailCount(), 500);
            } else {
                this.showError('Invalid API key. Please check and try again.');
            }
        } catch (error) {
            console.error('Error testing API key:', error);
            this.showError('Failed to test API key: ' + error.message);
        } finally {
            saveButton.textContent = originalText;
            saveButton.disabled = false;
        }
    }

    async testApiKey(apiKey) {
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + apiKey, {
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
            
            return response.ok;
        } catch (error) {
            console.error('API key test failed:', error);
            return false;
        }
    }

    async checkGmailTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url || !tab.url.includes('mail.google.com')) {
                this.showError('Please open Gmail to use MailMind');
                return false;
            }
            this.hideError();
            return true;
        } catch (error) {
            console.error('Error checking Gmail tab:', error);
            this.showError('Unable to access current tab');
            return false;
        }
    }

    async loadEmailCount() {
        if (this.isLoading) {
            console.log('Already loading, skipping request');
            return;
        }

        if (!this.apiKey) {
            this.showApiSetup();
            return;
        }

        if (!await this.checkGmailTab()) {
            return;
        }

        this.isLoading = true;
        this.showLoading(true);
        this.hideError();

        try {
            // Get current tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            console.log('MailMind: Requesting email count from tab', tab.id);
            
            // Add timeout to the message sending
            const response = await Promise.race([
                chrome.tabs.sendMessage(tab.id, { action: 'getEmailsToday' }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Request timeout after 15 seconds')), 15000)
                )
            ]);

            console.log('MailMind: Received response:', response);

            if (response.error) {
                throw new Error(response.error);
            }

            // Update email count only
            const emailCount = response.emails ? response.emails.length : 0;
            
            console.log('MailMind: Updating UI with', emailCount, 'emails today');
            
            document.getElementById('emailCount').textContent = emailCount.toString();

            if (emailCount === 0) {
                this.showEmptyState();
            } else {
                this.hideEmptyState();
            }

        } catch (error) {
            console.error('Error loading email count:', error);
            
            // Handle specific error cases
            if (error.message.includes('Could not establish connection')) {
                this.showError('MailMind content script not loaded. Please refresh Gmail and try again.');
            } else if (error.message.includes('timeout')) {
                this.showError('Request timed out. Gmail may be slow to load. Please try again.');
            } else {
                this.showError('Failed to load email count: ' + error.message);
            }
            
            // Reset count on error
            document.getElementById('emailCount').textContent = '-';
        } finally {
            this.isLoading = false;
            this.showLoading(false);
        }
    }

    showLoading(show) {
        document.getElementById('loading').style.display = show ? 'block' : 'none';
        document.getElementById('emptyState').style.display = 'none';
        document.getElementById('errorState').style.display = 'none';
        
        // Hide/show main content stats
        const statsSection = document.querySelector('.stats-section');
        const infoSection = document.querySelector('.info-section');
        if (statsSection) statsSection.style.display = show ? 'none' : 'grid';
        if (infoSection) infoSection.style.display = show ? 'none' : 'block';
    }

    showEmptyState() {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('errorState').style.display = 'none';
        
        // Hide main content
        const statsSection = document.querySelector('.stats-section');
        const infoSection = document.querySelector('.info-section');
        if (statsSection) statsSection.style.display = 'none';
        if (infoSection) infoSection.style.display = 'none';
    }

    hideEmptyState() {
        document.getElementById('emptyState').style.display = 'none';
        
        // Show main content
        const statsSection = document.querySelector('.stats-section');
        const infoSection = document.querySelector('.info-section');
        if (statsSection) statsSection.style.display = 'grid';
        if (infoSection) infoSection.style.display = 'block';
    }

    showError(message) {
        console.error('MailMind: Showing error:', message);
        
        // Show error in API setup if visible
        const apiError = document.getElementById('apiError');
        const apiSetup = document.getElementById('apiSetup');
        
        if (apiSetup && apiSetup.style.display !== 'none') {
            if (apiError) {
                apiError.textContent = message;
                apiError.style.display = 'block';
            }
        } else {
            // Show in main error state
            document.getElementById('loading').style.display = 'none';
            document.getElementById('emptyState').style.display = 'none';
            document.getElementById('errorState').style.display = 'block';
            document.getElementById('errorMessage').textContent = message;
            
            // Hide main content
            const statsSection = document.querySelector('.stats-section');
            const infoSection = document.querySelector('.info-section');
            if (statsSection) statsSection.style.display = 'none';
            if (infoSection) infoSection.style.display = 'none';
        }
    }

    hideError() {
        const apiError = document.getElementById('apiError');
        if (apiError) {
            apiError.style.display = 'none';
        }
        document.getElementById('errorState').style.display = 'none';
    }
}

// Initialize the popup when DOM is loaded with error handling
document.addEventListener('DOMContentLoaded', () => {
    try {
        new MailMindPopup();
    } catch (error) {
        console.error('Failed to initialize MailMind popup:', error);
    }
});