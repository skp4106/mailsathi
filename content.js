class GmailContentScript {
    constructor() {
        this.observer = null;
        this.currentEmailId = null;
        this.currentSidebar = null;
        this.isInitialized = false;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.apiKey = null;
        
        // Caching and queue properties
        this.summaryCache = new Map();
        this.inFlightSummaries = new Map();
        this.summaryQueue = [];
        this.isProcessingSummaryQueue = false;
        this.summaryCacheStorageKey = 'mailmindSummaryCacheV1';
        this._originalGenerateEmailSummary = null;
        this._summaryWrapperInstalled = false;
        
        // New properties for multi-email selection
        this.multiSelectObserver = null;
        this.selectedEmails = new Set();
        this.multiSelectSidebar = null;
        this.isMultiSelectMode = false;
        this.isMultiSidebarHidden = false; // Track sidebar visibility
        this.lastMultiSelectData = null; // Store last processed data
        this.multiSidebarUnhideBtn = null; // Floating unhide button for multi-select sidebar
        
        this.init();
    }

    async init() {
        await this.delay(1000); // Reduced from 2000ms
        await this.loadApiKey();
        await this.loadSummaryCache();
        this.installSummaryWrapper();
        
        // Load all styles during initialization to prevent CSS glitches
        this.addSidebarStyles();
        this.addMultiSidebarStyles();
        
        this.setupMessageListener();
        this.startObservingGmail();
        this.startObservingMultiSelect();
        this.setupUrlChangeDetection();
        this.isInitialized = true;
        console.log('MailMind content script initialized with multi-select support');
        
        // Check immediately if an email is already open
        setTimeout(() => {
            this.checkForOpenEmail();
        }, 500);
    }
    
    // Detect URL changes in Gmail (SPA navigation)
    setupUrlChangeDetection() {
        let lastUrl = location.href;
        
        // Check for URL changes periodically
        setInterval(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log('MailMind: URL changed from', lastUrl, 'to', currentUrl);
                lastUrl = currentUrl;
                
                // Wait a bit for Gmail to render the new view
                setTimeout(() => {
                    this.checkForOpenEmail();
                }, 400); // Reduced from 800ms for faster response
            }
        }, 300); // Reduced from 500ms for more frequent checks
    }
    
    // Manually check if an email is open
    checkForOpenEmail() {
        // Use the same logic as the observer
        this.checkAndShowSidebar();
    }

    async loadApiKey() {
        try {
            const result = await chrome.storage.local.get(['geminiApiKey']);
            this.apiKey = result.geminiApiKey;
        } catch (error) {
            console.error('Error loading API key:', error);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ===== Caching + Queue: Initialization & Utilities =====
    async loadSummaryCache() {
        try {
            const result = await chrome.storage.local.get([this.summaryCacheStorageKey]);
            const raw = result[this.summaryCacheStorageKey] || {};
            this.summaryCache = new Map(Object.entries(raw));
            console.log('MailMind: Loaded summary cache with', this.summaryCache.size, 'entries');
        } catch (e) {
            console.warn('MailMind: Failed to load summary cache', e);
            this.summaryCache = new Map();
        }
    }

    installSummaryWrapper() {
        if (this._summaryWrapperInstalled) return;
        // Keep a reference to the original method and replace with wrapper
        this._originalGenerateEmailSummary = this.generateEmailSummary.bind(this);
        this.generateEmailSummary = this.generateEmailSummaryWithCacheQueue.bind(this);
        this._summaryWrapperInstalled = true;
        console.log('MailMind: Installed summary wrapper with cache + queue');
    }

    async generateEmailSummaryWithCacheQueue(emailContent, emailSubject, emailSender, options = {}) {
        try {
            const id = await this.computeSummaryId(
                options?.id,
                emailSubject,
                emailContent,
                options?.time || ''
            );

            // 1) Cache hit
            const cached = this.getCachedSummary(id);
            if (cached) {
                return cached;
            }

            // 2) In-flight reuse
            if (this.inFlightSummaries.has(id)) {
                return await this.inFlightSummaries.get(id);
            }

            // 3) Enqueue a new task (concurrency = 1)
            const taskPromise = this.enqueueSummaryTask(id, async () => {
                const summary = await this._originalGenerateEmailSummary(emailContent, emailSubject, emailSender);
                await this.setCachedSummary(id, summary);
                return summary;
            });

            this.inFlightSummaries.set(id, taskPromise);
            try {
                const result = await taskPromise;
                return result;
            } finally {
                this.inFlightSummaries.delete(id);
            }
        } catch (err) {
            // Fall back to original on unexpected wrapper errors
            console.warn('MailMind: Wrapper error, falling back', err);
            return await this._originalGenerateEmailSummary(emailContent, emailSubject, emailSender);
        }
    }

    enqueueSummaryTask(id, runFn) {
        return new Promise((resolve, reject) => {
            this.summaryQueue.push({ id, runFn, resolve, reject });
            this.processSummaryQueue();
        });
    }

    async processSummaryQueue() {
        if (this.isProcessingSummaryQueue) return;
        const task = this.summaryQueue.shift();
        if (!task) return;

        this.isProcessingSummaryQueue = true;
        try {
            const res = await task.runFn();
            task.resolve(res);
        } catch (e) {
            task.reject(e);
        } finally {
            this.isProcessingSummaryQueue = false;
            if (this.summaryQueue.length > 0) {
                // Continue processing remaining tasks
                this.processSummaryQueue();
            }
        }
    }

    getCachedSummary(id) {
        return this.summaryCache.get(id) || null;
    }

    async setCachedSummary(id, summary) {
        try {
            this.summaryCache.set(id, summary);
            // Persist incrementally
            const result = await chrome.storage.local.get([this.summaryCacheStorageKey]);
            const raw = result[this.summaryCacheStorageKey] || {};
            raw[id] = summary;
            await chrome.storage.local.set({ [this.summaryCacheStorageKey]: raw });
        } catch (e) {
            console.warn('MailMind: Failed to persist summary to cache', e);
        }
    }

    async computeSummaryId(explicitId, subject, body, time) {
        if (explicitId && typeof explicitId === 'string') return explicitId;

        // Prefer message-id from open email view if available
        const mid = this.getOpenMessageIdFromDOM();
        if (mid) return `mid:${mid}`;

        const first50 = (body || '').substring(0, 50);
        const t = time || this.extractOpenEmailTimeFromDOM() || '';
        const composite = `${subject || ''}|${t}|${first50}`;
        const hex = await this.computeSHA256Hex(composite);
        return `hash:${hex}`;
    }

    getOpenMessageIdFromDOM() {
        try {
            const el = document.querySelector('[role="main"] [data-message-id]') ||
                      document.querySelector('[data-message-id]');
            const mid = el?.getAttribute('data-message-id');
            return mid || '';
        } catch {
            return '';
        }
    }

    extractOpenEmailTimeFromDOM() {
        try {
            const timeEl = document.querySelector('[role="main"] time') || document.querySelector('time');
            if (timeEl) {
                return timeEl.getAttribute('datetime') || (timeEl.textContent || '').trim();
            }
            const alt = document.querySelector('.g3 span') || document.querySelector('.gH [title]');
            if (alt) {
                return alt.getAttribute('title') || (alt.textContent || '').trim();
            }
        } catch { /* no-op */ }
        return '';
    }

    async computeRowEmailId(row, emailData) {
        try {
            const midEl = row.querySelector('[data-message-id]') || row.closest('[data-message-id]');
            const mid = midEl?.getAttribute('data-message-id');
            if (mid) return `mid:${mid}`;
        } catch { /* ignore */ }

        const first50 = (emailData.fullContent || emailData.preview || '').substring(0, 50);
        const composite = `${emailData.subject || ''}|${emailData.time || ''}|${first50}`;
        const hex = await this.computeSHA256Hex(composite);
        return `hash:${hex}`;
    }

    async computeSHA256Hex(input) {
        const enc = new TextEncoder();
        const data = enc.encode(input || '');
        const hash = await crypto.subtle.digest('SHA-256', data);
        const bytes = new Uint8Array(hash);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'getEmailsToday') {
                console.log('MailMind: Received request for emails');
                this.getEmailsFromToday()
                    .then(result => {
                        console.log('MailMind: Sending response:', result);
                        sendResponse(result);
                    })
                    .catch(error => {
                        console.error('MailMind: Error getting emails:', error);
                        sendResponse({ error: error.message });
                    });
                return true;
            }
        });
    }

    // Start observing for multi-email selection
    startObservingMultiSelect() {
        let multiSelectDebounce = null;
        
        this.multiSelectObserver = new MutationObserver((mutations) => {
            // Debounce to prevent excessive checks
            if (multiSelectDebounce) {
                clearTimeout(multiSelectDebounce);
            }
            
            multiSelectDebounce = setTimeout(() => {
                this.checkMultiSelectState();
            }, 200);
        });

        this.multiSelectObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-selected', 'aria-checked']
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearMultiSelect();
            }
        });

        document.addEventListener('click', (e) => {
            if (e.target.matches('input[type="checkbox"]') || 
                e.target.closest('.oZ-x3d') || 
                e.target.closest('[role="checkbox"]')) {
                setTimeout(() => this.checkMultiSelectState(), 150);
            }
        });
        
        console.log('MailMind: Started observing multi-select');
    }

    // Check if multiple emails are selected
    checkMultiSelectState() {
        // Don't show multi-select sidebar if a single email is open
        const isSingleEmailOpen = document.querySelector('[role="main"] [data-message-id]') ||
                                  document.querySelector('.ii.gt .a3s.aiL');
        
        if (isSingleEmailOpen) {
            // Single email is open, don't show multi-select sidebar
            if (this.isMultiSelectMode) {
                this.clearMultiSelect();
            }
            return;
        }
        
        const selectedRows = this.getSelectedEmailRows();
        
        // Only show multi-select if we have 2 or more emails selected
        if (selectedRows.length >= 2) {
            if (!this.isMultiSelectMode) {
                console.log('MailMind: Multi-select mode activated -', selectedRows.length, 'emails');
                this.isMultiSelectMode = true;
                this.handleMultiSelect(selectedRows);
            } else if (selectedRows.length !== this.selectedEmails.size) {
                // Selection changed, update only if sidebar is visible or no previous data
                if (!this.isMultiSidebarHidden || !this.lastMultiSelectData) {
                    this.handleMultiSelect(selectedRows);
                } else {
                    // Just update the stored selection without processing
                    this.selectedEmails = new Set(selectedRows);
                }
            }
        } else if (selectedRows.length < 2 && this.isMultiSelectMode) {
            console.log('MailMind: Multi-select mode deactivated');
            this.clearMultiSelect();
        }
    }

    // Get currently selected email rows
    getSelectedEmailRows() {
        const selectedRows = [];
        
        const selectors = [
            'tr[aria-selected="true"]',
            'tr.x7',
            'tr.yW.x7',
            'tr[jsaction*="click"]:has(input[type="checkbox"]:checked)',
            'tr:has(.oZ-x3d[aria-checked="true"])',
            'tr:has([role="checkbox"][aria-checked="true"])'
        ];

        for (const selector of selectors) {
            try {
                const rows = document.querySelectorAll(selector);
                if (rows.length > 0) {
                    selectedRows.push(...Array.from(rows));
                    break;
                }
            } catch (error) {
                continue;
            }
        }

        return [...new Set(selectedRows)];
    }

    // Handle multi-email selection
    async handleMultiSelect(selectedRows) {
        if (!this.apiKey) {
            console.log('No API key available for multi-email processing');
            return;
        }

        // Remove single email sidebar if it exists
        this.removeEmailSidebar();

        try {
            const emailsData = [];
            
            for (const row of selectedRows.slice(0, 10)) {
                const emailData = this.extractEmailData(row);
                if (emailData) {
                    const fullContent = await this.tryGetFullEmailContent(row);
                    emailData.fullContent = fullContent || emailData.preview;
                    try {
                        emailData.id = await this.computeRowEmailId(row, emailData);
                    } catch (e) {
                        // Non-blocking fallback ID
                        emailData.id = `${emailData.subject || ''}|${emailData.time || ''}|${(emailData.fullContent || emailData.preview || '').substring(0,50)}`;
                    }
                    emailsData.push(emailData);
                }
            }

            if (emailsData.length > 1) {
                this.selectedEmails = new Set(selectedRows);
                this.lastMultiSelectData = emailsData;
                
                // Show sidebar if it's hidden, or create new one
                if (this.isMultiSidebarHidden && this.multiSelectSidebar) {
                    this.showMultiSidebar();
                    this.updateMultiSidebarLoading();
                } else {
                    await this.createMultiEmailSidebar(emailsData);
                }
                
                // Generate summaries
                try {
                    const summaries = await this.generateMultiEmailSummaries(emailsData);
                    this.updateMultiSidebarContent(this.multiSelectSidebar, emailsData, summaries);
                } catch (error) {
                    console.error('Error generating multi-email summaries:', error);
                    this.updateMultiSidebarError(this.multiSelectSidebar, error.message);
                }
            }

        } catch (error) {
            console.error('Error handling multi-select:', error);
        }
    }

    // Try to get full email content
    async tryGetFullEmailContent(row) {
        try {
            const preview = this.extractPreview(row);
            return preview;
        } catch (error) {
            return null;
        }
    }

    // Create sidebar for multiple emails with hide functionality
    async createMultiEmailSidebar(emailsData) {
        this.removeMultiSelectSidebar();

        const sidebar = document.createElement('div');
        sidebar.id = 'mailmind-multi-sidebar';
        sidebar.className = 'mailmind-multi-sidebar';
        
        sidebar.innerHTML = `
            <div class="mailmind-sidebar-header">
                <div class="mailmind-sidebar-title">
                    <span class="mailmind-icon">📚</span>
                    <span>MailMind - ${emailsData.length} Emails</span>
                </div>
                <div class="mailmind-header-buttons">
                    <button class="mailmind-hide-btn" title="Hide sidebar">−</button>
                    <button class="mailmind-close-btn" title="Close sidebar">&times;</button>
                </div>
            </div>
            <div class="mailmind-sidebar-content">
                <div class="mailmind-loading">
                    <div class="mailmind-spinner"></div>
                    <p>Generating summaries for ${emailsData.length} emails...</p>
                </div>
            </div>
        `;
        
        document.body.appendChild(sidebar);
        this.multiSelectSidebar = sidebar;
        this.isMultiSidebarHidden = false;

        // Add event listeners
        sidebar.querySelector('.mailmind-close-btn').addEventListener('click', () => {
            this.clearMultiSelect();
        });

        sidebar.querySelector('.mailmind-hide-btn').addEventListener('click', () => {
            this.toggleMultiSidebar();
        });
    }

    // Toggle sidebar visibility
    toggleMultiSidebar() {
        if (!this.multiSelectSidebar) return;

        if (this.isMultiSidebarHidden) {
            this.showMultiSidebar();
        } else {
            this.hideMultiSidebar();
        }
    }

    // Hide sidebar
    hideMultiSidebar() {
        if (!this.multiSelectSidebar) return;
        
        this.multiSelectSidebar.classList.add('mailmind-sidebar-hidden');
        this.isMultiSidebarHidden = true;
        
        // Update hide button text
        const hideBtn = this.multiSelectSidebar.querySelector('.mailmind-hide-btn');
        if (hideBtn) {
            hideBtn.innerHTML = '+';
            hideBtn.title = 'Show sidebar';
        }

        // Show floating unhide button
        this.createMultiUnhideButton();
    }

    // Show sidebar
    showMultiSidebar() {
        if (!this.multiSelectSidebar) return;
        
        this.multiSelectSidebar.classList.remove('mailmind-sidebar-hidden');
        this.isMultiSidebarHidden = false;
        
        // Update hide button text
        const hideBtn = this.multiSelectSidebar.querySelector('.mailmind-hide-btn');
        if (hideBtn) {
            hideBtn.innerHTML = '−';
            hideBtn.title = 'Hide sidebar';
        }

        // Remove floating unhide button when sidebar is visible
        this.removeMultiUnhideButton();

        // Re-check selection state to refresh content if it changed while hidden
        try {
            this.checkMultiSelectState();
        } catch (e) {
            // no-op
        }
    }

    // Create a floating button to unhide multi-select sidebar
    createMultiUnhideButton() {
        if (this.multiSidebarUnhideBtn || !this.isMultiSelectMode) return;

        const btn = document.createElement('button');
        btn.className = 'mailmind-multi-unhide-btn';
        btn.type = 'button';
        btn.title = 'Show MailMind summaries';
        btn.setAttribute('aria-label', 'Show MailMind summaries');
        btn.textContent = '📚';

        btn.addEventListener('click', () => {
            this.showMultiSidebar();
        });

        document.body.appendChild(btn);
        this.multiSidebarUnhideBtn = btn;
    }

    // Remove the floating unhide button if present
    removeMultiUnhideButton() {
        if (this.multiSidebarUnhideBtn && this.multiSidebarUnhideBtn.parentNode) {
            this.multiSidebarUnhideBtn.parentNode.removeChild(this.multiSidebarUnhideBtn);
        }
        this.multiSidebarUnhideBtn = null;
    }

    // Update sidebar to loading state
    updateMultiSidebarLoading() {
        if (!this.multiSelectSidebar || !this.lastMultiSelectData) return;

        const content = this.multiSelectSidebar.querySelector('.mailmind-sidebar-content');
        if (content) {
            content.innerHTML = `
                <div class="mailmind-loading">
                    <div class="mailmind-spinner"></div>
                    <p>Generating summaries for ${this.lastMultiSelectData.length} emails...</p>
                </div>
            `;
        }
    }

    // Generate summaries for multiple emails
    async generateMultiEmailSummaries(emailsData) {
        const summaries = [];
        
        for (const email of emailsData) {
            const cached = email.id ? this.getCachedSummary(email.id) : null;
            if (cached) {
                summaries.push({ ...email, summary: cached });
                try {
                    if (this.multiSelectSidebar) {
                        this.updateMultiSidebarContent(this.multiSelectSidebar, emailsData, summaries);
                    }
                } catch { /* no-op */ }
                continue; // Skip API call and delay
            }

            try {
                const summary = await this.generateEmailSummary(
                    email.fullContent || email.preview,
                    email.subject,
                    email.sender,
                    { id: email.id, time: email.time }
                );
                summaries.push({
                    ...email,
                    summary: summary
                });
            } catch (error) {
                summaries.push({
                    ...email,
                    summary: 'Error generating summary: ' + error.message
                });
            }

            // Incremental UI update for multi-select as each summary completes
            try {
                if (this.multiSelectSidebar) {
                    this.updateMultiSidebarContent(this.multiSelectSidebar, emailsData, summaries);
                }
            } catch { /* no-op */ }
            
            await this.delay(500);
        }

        return summaries;
    }

    // Update multi-sidebar content
    updateMultiSidebarContent(sidebar, emailsData, summaryData) {
        if (!sidebar) return;
        
        const content = sidebar.querySelector('.mailmind-sidebar-content');
        
        let individualSummariesHTML = '';
        summaryData.forEach((email, index) => {
            individualSummariesHTML += `
                <div class="mailmind-email-item">
                    <div class="mailmind-email-header">
                        <div class="mailmind-email-sender">${this.escapeHtml(email.sender)}</div>
                        <div class="mailmind-email-time">${this.escapeHtml(email.time)}</div>
                    </div>
                    <div class="mailmind-email-subject">${this.escapeHtml(email.subject)}</div>
                    <div class="mailmind-email-summary">${this.escapeHtml(email.summary)}</div>
                </div>
            `;
        });
        
        content.innerHTML = `
            <div class="mailmind-individual-section">
                <h4>📧 Email Summaries</h4>
                <div class="mailmind-emails-list">
                    ${individualSummariesHTML}
                </div>
            </div>
            
            <div class="mailmind-actions-section">
                <button class="mailmind-export-btn">Export Summaries</button>
                <button class="mailmind-clear-selection-btn">Clear Selection</button>
            </div>
        `;

        // Add event listeners
        content.querySelector('.mailmind-export-btn').addEventListener('click', () => {
            this.exportSummaries(summaryData);
        });

        content.querySelector('.mailmind-clear-selection-btn').addEventListener('click', () => {
            this.clearMultiSelect();
        });
    }

    // Export summaries
    exportSummaries(summaryData) {
        let exportText = `MailMind - Email Summaries Export\n`;
        exportText += `Generated on: ${new Date().toLocaleString()}\n\n`;
        
        exportText += `EMAIL SUMMARIES:\n`;
        summaryData.forEach((email, index) => {
            exportText += `\n${index + 1}. From: ${email.sender}\n`;
            exportText += `   Subject: ${email.subject}\n`;
            exportText += `   Time: ${email.time}\n`;
            exportText += `   Summary: ${email.summary}\n`;
        });

        const blob = new Blob([exportText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mailmind-summaries-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.showTemporaryMessage('Summaries exported successfully!');
    }

    // Update multi-sidebar with error
    updateMultiSidebarError(sidebar, errorMessage) {
        if (!sidebar) return;
        
        const content = sidebar.querySelector('.mailmind-sidebar-content');
        content.innerHTML = `
            <div class="mailmind-error">
                <div class="mailmind-error-icon">⚠️</div>
                <h4>Unable to process emails</h4>
                <p>${this.escapeHtml(errorMessage)}</p>
                <button class="mailmind-retry-btn">Try Again</button>
            </div>
        `;

        content.querySelector('.mailmind-retry-btn').addEventListener('click', () => {
            const selectedRows = this.getSelectedEmailRows();
            if (selectedRows.length > 1) {
                this.handleMultiSelect(selectedRows);
            }
        });
    }

    // Clear multi-selection
    clearMultiSelect() {
        this.isMultiSelectMode = false;
        this.isMultiSidebarHidden = false;
        this.selectedEmails.clear();
        this.lastMultiSelectData = null;
        this.removeMultiSelectSidebar();
        this.removeMultiUnhideButton();
        
        try {
            // First, try to uncheck all individual email checkboxes
            const checkedBoxes = document.querySelectorAll('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]');
            checkedBoxes.forEach(checkbox => {
                try {
                    if (checkbox.type === 'checkbox') {
                        checkbox.click();
                    } else if (checkbox.getAttribute('role') === 'checkbox') {
                        checkbox.click();
                    }
                } catch (e) {
                    // Continue if one fails
                }
            });
            
            // Also try the select all checkbox as fallback
            const selectAllCheckbox = document.querySelector('input[aria-label*="Select"]');
            if (selectAllCheckbox && selectAllCheckbox.checked) {
                selectAllCheckbox.click();
            }
            
            // Remove aria-selected from rows
            const selectedRows = document.querySelectorAll('tr[aria-selected="true"]');
            selectedRows.forEach(row => {
                row.setAttribute('aria-selected', 'false');
                row.classList.remove('x7', 'btb');
            });
            
        } catch (error) {
            console.log('Error clearing selection:', error);
        }
    }

    // Remove multi-select sidebar
    removeMultiSelectSidebar() {
        if (this.multiSelectSidebar) {
            this.multiSelectSidebar.remove();
            this.multiSelectSidebar = null;
            this.isMultiSidebarHidden = false;
        }
        this.removeMultiUnhideButton();
    }

    // Add styles for multi-select sidebar with fixed height and scrollable email list
    addMultiSidebarStyles() {
        // Only add styles once, don't remove and re-add
        if (document.getElementById('mailmind-multi-sidebar-styles')) {
            console.log('MailMind: Multi-select sidebar styles already loaded');
            return;
        }

        console.log('MailMind: Adding multi-select sidebar styles');
        const styles = document.createElement('style');
        styles.id = 'mailmind-multi-sidebar-styles';
        styles.textContent = `
            /* MailMind Multi-Sidebar Styles - Fixed Height with Scrollable Email List */
            .mailmind-multi-sidebar {
                position: fixed !important;
                top: 80px !important;
                right: 20px !important;
                width: 400px !important;
                height: 85vh !important;
                background: white !important;
                border: 1px solid #e1e5e9 !important;
                border-radius: 12px !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.15) !important;
                z-index: 999999 !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                overflow: hidden !important;
                animation: mailmindSlideInRight 0.3s ease-out !important;
                transition: transform 0.3s ease, opacity 0.3s ease !important;
                display: flex !important;
                flex-direction: column !important;
            }

            /* Hidden state - move completely off-screen and disable interactions */
            .mailmind-multi-sidebar.mailmind-sidebar-hidden {
                transform: translateX(100%) !important;
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }

            .mailmind-multi-sidebar.mailmind-sidebar-hidden .mailmind-sidebar-content {
                display: none !important;
            }

            .mailmind-multi-sidebar.mailmind-sidebar-hidden .mailmind-sidebar-title span:last-child {
                display: none !important;
            }

            @keyframes mailmindSlideInRight {
                from {
                    opacity: 0;
                    transform: translateX(100%);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }

            .mailmind-multi-sidebar .mailmind-sidebar-header {
                background: #0077B6 !important;
                color: white !important;
                padding: 16px !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                flex-shrink: 0 !important;
            }

            .mailmind-multi-sidebar .mailmind-sidebar-title {
                display: flex !important;
                align-items: center !important;
                gap: 8px !important;
                font-weight: 600 !important;
                font-size: 16px !important;
            }

            .mailmind-multi-sidebar .mailmind-header-buttons {
                display: flex !important;
                gap: 4px !important;
            }

            .mailmind-multi-sidebar .mailmind-close-btn,
            .mailmind-multi-sidebar .mailmind-hide-btn {
                background: none !important;
                border: none !important;
                color: white !important;
                font-size: 20px !important;
                cursor: pointer !important;
                padding: 4px 8px !important;
                border-radius: 4px !important;
                transition: background-color 0.2s !important;
                width: 32px !important;
                height: 32px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
            }

            .mailmind-multi-sidebar .mailmind-close-btn:hover,
            .mailmind-multi-sidebar .mailmind-hide-btn:hover {
                background-color: rgba(255,255,255,0.2) !important;
            }

            .mailmind-multi-sidebar .mailmind-sidebar-content {
                flex: 1 !important;
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
                padding: 0 !important;
            }

            .mailmind-multi-sidebar .mailmind-loading {
                flex: 1 !important;
                display: flex !important;
                flex-direction: column !important;
                justify-content: center !important;
                align-items: center !important;
                padding: 40px 20px !important;
            }

            .mailmind-multi-sidebar .mailmind-spinner {
                width: 32px !important;
                height: 32px !important;
                border: 3px solid #90E0EF !important;
                border-top: 3px solid #0077B6 !important;
                border-radius: 50% !important;
                animation: mailmindSpin 1s linear infinite !important;
                margin: 0 auto 16px !important;
            }

            @keyframes mailmindSpin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            .mailmind-multi-sidebar .mailmind-individual-section {
                flex: 1 !important;
                display: flex !important;
                flex-direction: column !important;
                padding: 20px 20px 0 20px !important;
                overflow: hidden !important;
            }

            .mailmind-multi-sidebar .mailmind-individual-section h4 {
                margin-bottom: 12px !important;
                color: #2d3748 !important;
                font-size: 14px !important;
                font-weight: 600 !important;
                flex-shrink: 0 !important;
            }

            .mailmind-multi-sidebar .mailmind-emails-list {
                flex: 1 !important;
                overflow-y: auto !important;
                padding-right: 8px !important;
                margin-right: -8px !important;
            }

            .mailmind-multi-sidebar .mailmind-email-item {
                background: #CAF0F8 !important;
                border: 1px solid #e2e8f0 !important;
                border-radius: 8px !important;
                padding: 12px !important;
                margin-bottom: 10px !important;
                transition: box-shadow 0.2s !important;
                flex-shrink: 0 !important;
            }

            .mailmind-multi-sidebar .mailmind-email-item:hover {
                box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
            }

            .mailmind-multi-sidebar .mailmind-email-item:last-child {
                margin-bottom: 0 !important;
            }

            .mailmind-multi-sidebar .mailmind-email-header {
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                margin-bottom: 6px !important;
            }

            .mailmind-multi-sidebar .mailmind-email-sender {
                font-size: 13px !important;
                color: #0077B6 !important;
                font-weight: 500 !important;
                max-width: 200px !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
            }

            .mailmind-multi-sidebar .mailmind-email-time {
                font-size: 11px !important;
                color: #718096 !important;
            }

            .mailmind-multi-sidebar .mailmind-email-subject {
                font-size: 13px !important;
                font-weight: 500 !important;
                color: #2d3748 !important;
                margin-bottom: 8px !important;
                line-height: 1.3 !important;
            }

            .mailmind-multi-sidebar .mailmind-email-summary {
                font-size: 12px !important;
                color: #4a5568 !important;
                line-height: 1.4 !important;
                background: white !important;
                padding: 8px 10px !important;
                border-radius: 4px !important;
                border-left: 3px solid #0077B6 !important;
            }

            .mailmind-multi-sidebar .mailmind-actions-section {
                flex-shrink: 0 !important;
                margin: 0 !important;
                padding: 16px 20px 20px 20px !important;
                border-top: 1px solid #e2e8f0 !important;
                display: flex !important;
                gap: 8px !important;
            }

            .mailmind-multi-sidebar .mailmind-export-btn,
            .mailmind-multi-sidebar .mailmind-clear-selection-btn,
            .mailmind-multi-sidebar .mailmind-retry-btn {
                flex: 1 !important;
                padding: 10px 16px !important;
                border: none !important;
                border-radius: 6px !important;
                font-size: 13px !important;
                font-weight: 500 !important;
                cursor: pointer !important;
                transition: all 0.2s !important;
            }

            .mailmind-multi-sidebar .mailmind-export-btn {
                background: #0077B6 !important;
                color: white !important;
            }

            .mailmind-multi-sidebar .mailmind-export-btn:hover {
                background: #03045E !important;
            }

            .mailmind-multi-sidebar .mailmind-clear-selection-btn {
                background: #edf2f7 !important;
                color: #4a5568 !important;
                border: 1px solid #e2e8f0 !important;
            }

            .mailmind-multi-sidebar .mailmind-clear-selection-btn:hover {
                background: #e2e8f0 !important;
            }

            .mailmind-multi-sidebar .mailmind-retry-btn {
                background: #0077B6 !important;
                color: white !important;
                width: 100% !important;
            }

            .mailmind-multi-sidebar .mailmind-retry-btn:hover {
                background: #03045E !important;
            }

            /* Custom scrollbar for the emails list */
            .mailmind-multi-sidebar .mailmind-emails-list::-webkit-scrollbar {
                width: 6px !important;
            }

            .mailmind-multi-sidebar .mailmind-emails-list::-webkit-scrollbar-track {
                background: transparent !important;
            }

            .mailmind-multi-sidebar .mailmind-emails-list::-webkit-scrollbar-thumb {
                background: #cbd5e0 !important;
                border-radius: 3px !important;
            }

            .mailmind-multi-sidebar .mailmind-emails-list::-webkit-scrollbar-thumb:hover {
                background: #a0aec0 !important;
            }

            /* Floating unhide button for multi-select sidebar */
            .mailmind-multi-unhide-btn {
                position: fixed !important;
                bottom: 24px !important;
                right: 24px !important;
                width: 44px !important;
                height: 44px !important;
                border-radius: 50% !important;
                border: none !important;
                background: #0077B6 !important;
                color: #fff !important;
                font-size: 20px !important;
                line-height: 1 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                cursor: pointer !important;
                box-shadow: 0 8px 24px rgba(0,0,0,0.18) !important;
                z-index: 1000000 !important;
                transition: transform 0.15s ease, box-shadow 0.15s ease !important;
            }

            .mailmind-multi-unhide-btn:hover {
                transform: scale(1.06) !important;
                box-shadow: 0 10px 28px rgba(0,0,0,0.22) !important;
            }

            .mailmind-multi-unhide-btn:focus {
                outline: none !important;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.35) !important;
            }

            .mailmind-multi-sidebar .mailmind-error {
                flex: 1 !important;
                display: flex !important;
                flex-direction: column !important;
                justify-content: center !important;
                align-items: center !important;
                padding: 40px 20px !important;
            }

            .mailmind-multi-sidebar .mailmind-error-icon {
                font-size: 32px !important;
                margin-bottom: 12px !important;
            }

            .mailmind-multi-sidebar .mailmind-error h4 {
                color: #e53e3e !important;
                margin-bottom: 8px !important;
            }

            .mailmind-multi-sidebar .mailmind-error p {
                color: #718096 !important;
                font-size: 13px !important;
                line-height: 1.4 !important;
            }

            /* Responsive adjustments */
            @media (max-height: 600px) {
                .mailmind-multi-sidebar {
                    height: 90vh !important;
                }
            }

            @media (max-width: 500px) {
                .mailmind-multi-sidebar {
                    right: 10px !important;
                    width: calc(100vw - 20px) !important;
                    max-width: 400px !important;
                }
            }
        `;
        
        // Insert at the beginning of head to ensure it loads early
        document.head.insertBefore(styles, document.head.firstChild);
        console.log('MailMind: Multi-sidebar styles added');
    }

    // Rest of the existing methods remain the same...
    async getEmailsFromToday() {
        try {
            await this.waitForGmailLoadWithRetries();
            const emails = [];
            const emailRows = await this.getEmailRowsWithFallbacks();
            
            console.log('MailMind debug – emailRows found:', emailRows.length);
            
            if (emailRows.length === 0) {
                return {
                    emails: [],
                    debug: 'No email rows found in Gmail interface'
                };
            }
            
            for (const row of emailRows) {
                const emailData = this.extractEmailData(row);
                if (emailData) {
                    if (this.isFromToday(emailData.time)) {
                        emails.push(emailData);
                    }
                }
            }

            console.log('MailMind: Found', emails.length, 'emails today');

            return {
                emails: emails,
                debug: `Processed ${emailRows.length} rows, found ${emails.length} today's emails`
            };
        } catch (error) {
            console.error('Error getting emails:', error);
            return { 
                error: error.message,
                emails: []
            };
        }
    }

    async waitForGmailLoadWithRetries() {
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                await this.waitForGmailLoad();
                return;
            } catch (error) {
                console.log(`MailMind: Gmail load attempt ${attempt + 1} failed`);
                if (attempt === this.maxRetries - 1) {
                    throw error;
                }
                await this.delay(1000 * (attempt + 1));
            }
        }
    }

    waitForGmailLoad() {
        return new Promise((resolve, reject) => {
            const maxAttempts = 30;
            let attempts = 0;

            const checkGmail = () => {
                attempts++;
                const gmailSelectors = [
                    '[role="main"]', '.nH', '[gh="tl"]', '.aeJ', '.AO', '.Tm.aeJ', '[jscontroller="SoVkNd"]'
                ];
                
                let gmailContent = null;
                for (const selector of gmailSelectors) {
                    gmailContent = document.querySelector(selector);
                    if (gmailContent) break;
                }
                
                if (gmailContent) {
                    console.log('MailMind: Gmail interface detected');
                    resolve();
                } else if (attempts < maxAttempts) {
                    setTimeout(checkGmail, 500);
                } else {
                    reject(new Error('Gmail interface not found'));
                }
            };

            checkGmail();
        });
    }

    async getEmailRowsWithFallbacks() {
        const strategies = [
            () => this.getEmailRowsStrategy1(),
            () => this.getEmailRowsStrategy2(),
            () => this.getEmailRowsStrategy3(),
            () => this.getEmailRowsStrategy4()
        ];

        for (let i = 0; i < strategies.length; i++) {
            try {
                const rows = await strategies[i]();
                if (rows.length > 0) {
                    console.log(`MailMind: Strategy ${i + 1} found ${rows.length} email rows`);
                    return rows.slice(0, 50);
                }
            } catch (error) {
                console.log(`MailMind: Strategy ${i + 1} failed:`, error.message);
            }
        }
        return [];
    }

    getEmailRowsStrategy1() {
        const selectors = [
            'tr[jsaction*="mouseenter"]', 'tr[jsaction*="click"]', '.zA', '[data-legacy-thread-id]',
            '.Cp', 'tr.zA', 'tr.yW', '.yW', '[role="listitem"]', '[jsmodel="SzKmE"]'
        ];

        for (const selector of selectors) {
            const rows = document.querySelectorAll(selector);
            if (rows.length > 0) {
                return Array.from(rows).filter(row => {
                    const text = row.textContent;
                    return text && text.length > 10 && !text.includes('Compose') && !text.includes('Sent');
                });
            }
        }
        return [];
    }

    getEmailRowsStrategy2() {
        const tables = document.querySelectorAll('table[role="grid"], table.F');
        for (const table of tables) {
            const rows = table.querySelectorAll('tr');
            if (rows.length > 1) {
                return Array.from(rows).slice(1).filter(row => {
                    return row.cells && row.cells.length > 2;
                });
            }
        }
        return [];
    }

    getEmailRowsStrategy3() {
        const conversations = document.querySelectorAll('[data-thread-id], [data-legacy-thread-id]');
        if (conversations.length > 0) {
            return Array.from(conversations);
        }
        return [];
    }

    getEmailRowsStrategy4() {
        const elements = document.querySelectorAll('[aria-label*="email"], [aria-label*="message"], [aria-label*="conversation"]');
        return Array.from(elements).filter(el => {
            const ariaLabel = el.getAttribute('aria-label') || '';
            return ariaLabel.includes('@') || ariaLabel.includes('unread') || ariaLabel.includes('from');
        });
    }

    extractEmailData(row) {
        try {
            const emailData = {
                sender: this.extractSender(row),
                subject: this.extractSubject(row),
                preview: this.extractPreview(row),
                time: this.extractTime(row),
                isUnread: this.extractUnreadStatus(row)
            };

            if (!emailData.sender && !emailData.subject && !emailData.preview) {
                return null;
            }

            return emailData;
        } catch (error) {
            console.error('Error extracting email data:', error);
            return null;
        }
    }

    extractSender(row) {
        const senderSelectors = [
            '[email]', '.yW', '.yP', '[name]', '.go span[email]', 
            '.bA4 span', '.a4W span', '.yX span'
        ];

        for (const selector of senderSelectors) {
            const el = row.querySelector(selector);
            if (el) {
                return el.getAttribute('email') || 
                       el.getAttribute('name') || 
                       el.getAttribute('title') || 
                       el.textContent.trim();
            }
        }

        const text = row.textContent || '';
        const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (emailMatch) {
            return emailMatch[0];
        }

        return '';
    }

    extractSubject(row) {
        const subjectSelectors = [
            '.bog', '[data-thread-perm-id] .y6 span', '.y6 span', '.y6',
            '.aYS', '.Zt', '.a4W .ao9', '.bqe span'
        ];

        for (const selector of subjectSelectors) {
            const el = row.querySelector(selector);
            if (el && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return '';
    }

    extractPreview(row) {
        const previewSelectors = [
            '.y2', '.bog + span', '.y6 + .y2', '.aYS + .y2', '.Zt + span', '.snippetText'
        ];

        for (const selector of previewSelectors) {
            const el = row.querySelector(selector);
            if (el && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return '';
    }

    extractTime(row) {
        const timeSelectors = [
            'time', 'td.xW span', '.xW span', '.xY span', '[title*=":"]',
            '.xz', '.g3 span', '.byg span', 'span[title]', '.xY', '.xW'
        ];

        for (const selector of timeSelectors) {
            const el = row.querySelector(selector);
            if (el) {
                let timeText = el.getAttribute('title');
                if (timeText && timeText.trim()) {
                    timeText = this.cleanTimeText(timeText);
                    if (this.isValidTimeText(timeText)) {
                        return timeText;
                    }
                }
                
                timeText = el.textContent;
                if (timeText && timeText.trim()) {
                    timeText = this.cleanTimeText(timeText);
                    if (this.isValidTimeText(timeText)) {
                        return timeText;
                    }
                }
            }
        }

        const ariaLabel = row.getAttribute('aria-label') || '';
        if (ariaLabel) {
            const timePatterns = [
                /(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/g,
                /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?)\b/g,
                /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{4})?)\b/g,
                /\b(yesterday)\b/gi, /\b(today)\b/gi, /(\d{1,2}\/\d{1,2}\/\d{2,4})/g
            ];

            for (const pattern of timePatterns) {
                const matches = ariaLabel.match(pattern);
                if (matches && matches.length > 0) {
                    const timeText = this.cleanTimeText(matches[matches.length - 1]);
                    if (this.isValidTimeText(timeText)) {
                        return timeText;
                    }
                }
            }
        }

        const rowText = row.textContent || '';
        const timeInRowPattern = /\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\b/;
        const match = rowText.match(timeInRowPattern);
        if (match) {
            return this.cleanTimeText(match[1]);
        }

        return '';
    }

    isValidTimeText(timeText) {
        if (!timeText || timeText.length < 2) return false;
        const hasTime = /\d{1,2}:\d{2}/.test(timeText);
        const hasDate = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|yesterday|\d{1,2}\/\d{1,2})/i.test(timeText);
        return hasTime || hasDate;
    }

    extractUnreadStatus(row) {
        const unreadIndicators = [
            () => row.classList.contains('zE'),
            () => row.classList.contains('yW'),
            () => row.querySelector('.yW') !== null,
            () => row.querySelector('[style*="font-weight: bold"]') !== null,
            () => row.querySelector('[style*="font-weight:bold"]') !== null,
            () => row.querySelector('.zE') !== null,
            () => row.style.fontWeight === 'bold',
            () => {
                const ariaLabel = row.getAttribute('aria-label') || '';
                return ariaLabel.toLowerCase().includes('unread');
            }
        ];

        return unreadIndicators.some(indicator => {
            try {
                return indicator();
            } catch {
                return false;
            }
        });
    }

    isFromToday(timeText) {
        const text = this.cleanTimeText(timeText);
        if (!text) return false;

        const today = new Date();
        const todayDay = today.getDate();
        const todayMonth = today.getMonth();
        const todayYear = today.getFullYear();
        const lower = text.toLowerCase();

        try {
            if (lower.includes('yesterday')) return false;
            if (lower.includes('today')) return true;
            if (/^\d{1,2}:\d{2}\s*(?:am|pm)?$/i.test(text)) return true;

            const monthShort = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
            const monthLong = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const monthIdxShort = monthShort.findIndex(m => lower.includes(m));
            const monthIdxLong = monthLong.findIndex(m => lower.includes(m));
            const monthIdx = monthIdxShort !== -1 ? monthIdxShort : monthIdxLong;
            
            if (monthIdx !== -1) {
                const dayMatch = lower.match(/\b(\d{1,2})\b/);
                if (dayMatch) {
                    const d = parseInt(dayMatch[1], 10);
                    if (d === todayDay && monthIdx === todayMonth) return true;
                    return false;
                }
            }

            const slash = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
            if (slash) {
                const a = parseInt(slash[1], 10);
                const b = parseInt(slash[2], 10);
                const y = slash[3] ? parseInt(slash[3], 10) : todayYear;
                const yNorm = y < 100 ? 2000 + y : y;
                if (a - 1 === todayMonth && b === todayDay && yNorm === todayYear) return true;
                if (b - 1 === todayMonth && a === todayDay && yNorm === todayYear) return true;
                return false;
            }

            const iso = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
            if (iso) {
                const yi = parseInt(iso[1], 10);
                const mi = parseInt(iso[2], 10) - 1;
                const di = parseInt(iso[3], 10);
                return yi === todayYear && mi === todayMonth && di === todayDay;
            }

            const parsed = new Date(text);
            if (!isNaN(parsed)) {
                return parsed.getFullYear() === todayYear && 
                       parsed.getMonth() === todayMonth && 
                       parsed.getDate() === todayDay;
            }

            return false;
        } catch (error) {
            console.log('MailMind: Error parsing date:', text, error);
            return false;
        }
    }

    cleanTimeText(text) {
        return (text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\u202F/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Single email sidebar functionality
    startObservingGmail() {
        let debounceTimer = null;
        
        this.observer = new MutationObserver((mutations) => {
            // Clear existing timer
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            
            // Immediate check with minimal debounce
            debounceTimer = setTimeout(() => {
                this.checkAndShowSidebar();
            }, 100); // Very short debounce just to batch rapid changes
        });

        // Observe the main content area where emails appear
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false // Don't watch attributes, only DOM structure changes
        });
        
        console.log('MailMind: Started observing Gmail DOM changes');
    }
    
    checkAndShowSidebar() {
        // Look for email content in the main view
        const emailView = document.querySelector('[role="main"] [data-message-id]') ||
                        document.querySelector('[data-message-id]') ||
                        document.querySelector('.ii.gt .a3s.aiL') ||
                        document.querySelector('.a3s.aiL');
        
        // Check if we're in inbox list view (table with multiple emails)
        const isListView = document.querySelector('[role="main"] table.F.cf.zt') !== null;
        
        if (isListView && !emailView) {
            // In list view without open email - hide sidebar
            if (this.currentEmailId) {
                console.log('MailMind: List view detected, removing sidebar');
                this.removeEmailSidebar();
                this.currentEmailId = null;
            }
            return;
        }
        
        // If we found an email view, process it
        if (emailView) {
            const emailId = this.getEmailId(emailView);
            
            // Only process if it's a new email
            if (emailId && emailId !== this.currentEmailId) {
                console.log('MailMind: New email detected, ID:', emailId);
                this.currentEmailId = emailId;
                this.handleEmailOpen(emailView);
            }
        } else if (this.currentEmailId) {
            // No email view and we had one before - remove sidebar
            console.log('MailMind: Email closed, removing sidebar');
            this.removeEmailSidebar();
            this.currentEmailId = null;
        }
    }

    getEmailId(emailView) {
        const messageId = emailView.getAttribute('data-message-id') ||
                         emailView.closest('[data-message-id]')?.getAttribute('data-message-id') ||
                         emailView.closest('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
        
        if (messageId) return messageId;

        const subject = this.extractOpenEmailSubject(emailView);
        const sender = this.extractOpenEmailSender(emailView);
        
        return subject && sender ? `${sender}-${subject}`.substring(0, 50) : Date.now().toString();
    }

    async handleEmailOpen(emailView) {
        if (!this.apiKey) {
            console.log('MailMind: No API key available for email processing');
            return;
        }

        if (this.isMultiSelectMode) {
            console.log('MailMind: Multi-select mode active, skipping single email sidebar');
            return;
        }

        try {
            const emailContent = this.extractOpenEmailContent(emailView);
            const emailSubject = this.extractOpenEmailSubject(emailView);
            const emailSender = this.extractOpenEmailSender(emailView);

            if (!emailContent || emailContent.length < 10) {
                console.log('MailMind: No valid email content found');
                return;
            }

            if (!emailSubject || emailSubject.length < 2) {
                console.log('MailMind: No valid email subject found');
                return;
            }

            console.log('MailMind: Processing opened email -', emailSubject);
            await this.createEmailSidebar(emailContent, emailSubject, emailSender);
            
        } catch (error) {
            console.error('MailMind: Error handling email open:', error);
        }
    }

    extractOpenEmailContent(emailView) {
        const contentSelectors = [
            '.ii.gt .a3s.aiL',
            '.a3s.aiL',
            '[data-message-id] .a3s',
            '.ii.gt div[dir="ltr"]',
            '.hx .ii.gt div',
            '.a3s'
        ];

        for (const selector of contentSelectors) {
            const contentEl = emailView.querySelector(selector) || document.querySelector(selector);
            if (contentEl && contentEl.textContent.trim()) {
                return contentEl.textContent.trim();
            }
        }

        return null;
    }

    extractOpenEmailSubject(emailView) {
        const subjectSelectors = [
            'h2[data-thread-perm-id]',
            '.hP',
            '[data-thread-perm-id]',
            'h2',
            '.subject'
        ];

        for (const selector of subjectSelectors) {
            const subjectEl = document.querySelector(selector);
            if (subjectEl && subjectEl.textContent.trim()) {
                return subjectEl.textContent.trim();
            }
        }

        return 'Email';
    }

    extractOpenEmailSender(emailView) {
        const senderSelectors = [
            '.go .g2',
            '.go span[email]',
            '.gD',
            '[email]',
            '.sender'
        ];

        for (const selector of senderSelectors) {
            const senderEl = document.querySelector(selector);
            if (senderEl) {
                const email = senderEl.getAttribute('email') || senderEl.textContent.trim();
                if (email) return email;
            }
        }

        return 'Unknown Sender';
    }

    async createEmailSidebar(emailContent, emailSubject, emailSender) {
        // Prevent duplicate sidebars
        if (this.currentSidebar && document.body.contains(this.currentSidebar)) {
            console.log('MailMind: Sidebar already exists, skipping creation');
            return;
        }
        
        this.removeEmailSidebar();

        const sidebar = document.createElement('div');
        sidebar.id = 'mailmind-email-sidebar';
        sidebar.className = 'mailmind-sidebar';
        
        sidebar.innerHTML = `
            <div class="mailmind-sidebar-header">
                <div class="mailmind-sidebar-title">
                    <span class="mailmind-icon">🤖</span>
                    <span>MailMind AI</span>
                </div>
                <button class="mailmind-close-btn">&times;</button>
            </div>
            <div class="mailmind-sidebar-content">
                <div class="mailmind-loading">
                    <div class="mailmind-spinner"></div>
                    <p>Generating summary and reply...</p>
                </div>
            </div>
        `;
        
        document.body.appendChild(sidebar);
        this.currentSidebar = sidebar;

        sidebar.querySelector('.mailmind-close-btn').addEventListener('click', () => {
            this.removeEmailSidebar();
        });

        try {
            const summary = await this.generateEmailSummary(emailContent, emailSubject, emailSender);
            this.updateSidebarContent(sidebar, summary, null, emailContent, emailSubject, emailSender);
        } catch (error) {
            console.error('Error generating AI content:', error);
            this.updateSidebarError(sidebar, error.message);
        }
    }

    async generateEmailSummary(emailContent, emailSubject, emailSender) {
        const prompt = `Summarize this email in 2-3 clear sentences, focusing on key points and any action items:

From: ${emailSender}
Subject: ${emailSubject}

Content: ${emailContent}`;

        return await this.callGeminiAPI(prompt, 150);
    }

    async generateSuggestedReply(emailContent, emailSubject, emailSender) {
        const prompt = `Generate a professional, concise reply to this email. Keep it brief but appropriate:

From: ${emailSender}
Subject: ${emailSubject}

Content: ${emailContent}

Reply:`;

        return await this.callGeminiAPI(prompt, 200);
    }

    async generateCustomReply(emailContent, emailSubject, emailSender, userMessage) {
        const prompt = `You are helping compose a professional email reply. Based on the original email and the user's message/intent, generate a well-formatted, professional reply.

Original Email:
From: ${emailSender}
Subject: ${emailSubject}
Content: ${emailContent}

User's Message/Intent: ${userMessage}

Generate a professional reply that conveys the user's message in a polite and appropriate manner. Keep it concise but complete:

Reply:`;

        return await this.callGeminiAPI(prompt, 300);
    }

    async callGeminiAPI(prompt, maxTokens = 200) {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${this.apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.4,
                    topK: 32,
                    topP: 1,
                    maxOutputTokens: maxTokens,
                }
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!generatedText) {
            throw new Error('No content generated');
        }
        
        return generatedText.trim();
    }

    updateSidebarContent(sidebar, summary, suggestedReply, emailContent, emailSubject, emailSender) {
        const content = sidebar.querySelector('.mailmind-sidebar-content');
        content.innerHTML = `
            <div class="mailmind-section">
                <h4>📄 Email Summary</h4>
                <div class="mailmind-summary-text">${this.escapeHtml(summary)}</div>
            </div>
            <div class="mailmind-section mailmind-custom-reply-section">
                <h4>✍️ Custom Reply</h4>
                <p class="mailmind-custom-reply-hint">Type your message and we'll make it professional</p>
                <textarea class="mailmind-custom-input" placeholder="e.g., I can't come, I have other plans" rows="3"></textarea>
                <button class="mailmind-generate-custom-btn">Generate Reply</button>
                <div class="mailmind-custom-reply-result" style="display: none;">
                    <div class="mailmind-custom-reply-text"></div>
                    <div class="mailmind-reply-actions">
                        <button class="mailmind-use-custom-reply-btn">Use This Reply</button>
                        <button class="mailmind-copy-custom-reply-btn">Copy Reply</button>
                    </div>
                </div>
            </div>
        `;

        // Custom reply generation
        const generateBtn = content.querySelector('.mailmind-generate-custom-btn');
        const customInput = content.querySelector('.mailmind-custom-input');
        const customResult = content.querySelector('.mailmind-custom-reply-result');
        const customReplyText = content.querySelector('.mailmind-custom-reply-text');

        generateBtn.addEventListener('click', async () => {
            const userMessage = customInput.value.trim();
            if (!userMessage) {
                this.showTemporaryMessage('Please enter your message first', 'error');
                return;
            }

            // Show loading state
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
            customResult.style.display = 'none';

            try {
                const customReply = await this.generateCustomReply(
                    emailContent,
                    emailSubject,
                    emailSender,
                    userMessage
                );

                // Show the generated reply
                customReplyText.textContent = customReply;
                customResult.style.display = 'block';

                // Setup buttons for custom reply
                content.querySelector('.mailmind-use-custom-reply-btn').addEventListener('click', () => {
                    this.insertReplyIntoCompose(customReply);
                });

                content.querySelector('.mailmind-copy-custom-reply-btn').addEventListener('click', () => {
                    navigator.clipboard.writeText(customReply).then(() => {
                        const btn = content.querySelector('.mailmind-copy-custom-reply-btn');
                        const originalText = btn.textContent;
                        btn.textContent = 'Copied!';
                        setTimeout(() => {
                            btn.textContent = originalText;
                        }, 2000);
                    });
                });

            } catch (error) {
                console.error('Error generating custom reply:', error);
                this.showTemporaryMessage('Failed to generate reply: ' + error.message, 'error');
            } finally {
                generateBtn.disabled = false;
                generateBtn.textContent = 'Generate Reply';
            }
        });

        // Allow Enter key to generate (Shift+Enter for new line)
        customInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                generateBtn.click();
            }
        });
    }

    updateSidebarError(sidebar, errorMessage) {
        const content = sidebar.querySelector('.mailmind-sidebar-content');
        content.innerHTML = `
            <div class="mailmind-error">
                <div class="mailmind-error-icon">⚠️</div>
                <h4>Unable to process email</h4>
                <p>${this.escapeHtml(errorMessage)}</p>
            </div>
        `;
    }

    insertReplyIntoCompose(replyText) {
        console.log('MailMind: Attempting to insert reply into compose box');
        
        // Enhanced selectors for Gmail compose box
        const composeSelectors = [
            // Modern Gmail compose selectors
            'div[aria-label*="Message Body"][contenteditable="true"]',
            'div[aria-label*="Message body"][contenteditable="true"]',
            'div[role="textbox"][aria-label*="Message"]',
            'div[role="textbox"][contenteditable="true"]:not([aria-label*="Search"])',
            // Legacy selectors
            '[aria-label*="Message Body"]',
            '[contenteditable="true"][aria-label*="compose"]',
            '.Am.Al.editable',
            '[g_editable="true"]',
            '.editable[contenteditable="true"]',
            // Additional fallback selectors
            'div.Am.Al.editable[contenteditable="true"]',
            'div[contenteditable="true"][aria-label]',
            'div.editable[g_editable="true"]'
        ];

        // Try to find and insert into compose box
        for (const selector of composeSelectors) {
            try {
                const composeBox = document.querySelector(selector);
                if (composeBox && composeBox.isContentEditable) {
                    console.log('MailMind: Found compose box with selector:', selector);
                    
                    // Clear existing content
                    composeBox.innerHTML = '';
                    
                    // Insert the reply text with proper formatting
                    const formattedText = replyText.replace(/\n/g, '<br>');
                    composeBox.innerHTML = formattedText;
                    
                    // Focus and place cursor at the end
                    composeBox.focus();
                    
                    // Trigger input event to ensure Gmail recognizes the change
                    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                    composeBox.dispatchEvent(inputEvent);
                    
                    // Also trigger change event
                    const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                    composeBox.dispatchEvent(changeEvent);
                    
                    this.showTemporaryMessage('Reply inserted into compose box!');
                    return;
                }
            } catch (error) {
                console.log('MailMind: Error with selector', selector, error);
                continue;
            }
        }

        console.log('MailMind: No compose box found, attempting to open reply composer');
        
        // If no compose box found, try to open the reply composer
        const replyButtons = [
            // Reply button selectors
            'div[aria-label*="Reply"][role="button"]',
            'div[data-tooltip*="Reply"][role="button"]',
            '[aria-label*="Reply"]',
            '[data-tooltip*="Reply"]',
            '.ams.bkH .amn',
            'div[role="button"][aria-label="Reply"]',
            'span[role="link"][aria-label*="Reply"]'
        ];
        
        for (const selector of replyButtons) {
            try {
                const replyButton = document.querySelector(selector);
                if (replyButton) {
                    console.log('MailMind: Found reply button with selector:', selector);
                    replyButton.click();
                    
                    // Wait for compose box to appear and retry
                    setTimeout(() => {
                        console.log('MailMind: Retrying after opening reply composer');
                        this.insertReplyIntoCompose(replyText);
                    }, 1500);
                    return;
                }
            } catch (error) {
                console.log('MailMind: Error clicking reply button', selector, error);
                continue;
            }
        }
        
        console.log('MailMind: Could not find reply button or compose box');
        this.showTemporaryMessage('Please open the reply composer first by clicking Reply button');
    }

    showTemporaryMessage(message, type = 'success') {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'mailmind-temp-message';
        messageDiv.textContent = message;
        
        const backgroundColor = type === 'error' ? '#f44336' : '#4CAF50';
        
        messageDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${backgroundColor};
            color: white;
            padding: 12px 16px;
            border-radius: 6px;
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;
        
        document.body.appendChild(messageDiv);
        setTimeout(() => {
            if (messageDiv.parentNode) {
                messageDiv.parentNode.removeChild(messageDiv);
            }
        }, 3000);
    }

    removeEmailSidebar() {
        // Remove all mailmind sidebars from DOM to prevent duplicates
        const allSidebars = document.querySelectorAll('#mailmind-email-sidebar, .mailmind-sidebar:not(.mailmind-multi-sidebar)');
        allSidebars.forEach(sidebar => sidebar.remove());
        
        if (this.currentSidebar) {
            this.currentSidebar = null;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    addSidebarStyles() {
        if (document.getElementById('mailmind-sidebar-styles')) {
            console.log('MailMind: Single email sidebar styles already loaded');
            return;
        }

        console.log('MailMind: Adding single email sidebar styles');
        const styles = document.createElement('style');
        styles.id = 'mailmind-sidebar-styles';
        styles.textContent = `
            .mailmind-sidebar {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 350px;
                max-height: 80vh;
                background: white;
                border: 1px solid #e1e5e9;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.12);
                z-index: 9999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                overflow: hidden;
                animation: slideInRight 0.3s ease-out;
            }

            @keyframes slideInRight {
                from {
                    opacity: 0;
                    transform: translateX(100%);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }

            .mailmind-sidebar .mailmind-sidebar-header {
                background: #0077B6;
                color: white;
                padding: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .mailmind-sidebar .mailmind-sidebar-title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 600;
                font-size: 16px;
            }

            .mailmind-sidebar .mailmind-close-btn {
                background: none;
                border: none;
                color: white;
                font-size: 20px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                transition: background-color 0.2s;
            }

            .mailmind-sidebar .mailmind-close-btn:hover {
                background-color: rgba(255,255,255,0.2);
            }

            .mailmind-sidebar .mailmind-sidebar-content {
                padding: 20px;
                max-height: 60vh;
                overflow-y: auto;
            }

            .mailmind-sidebar .mailmind-loading {
                text-align: center;
                padding: 40px 20px;
            }

            .mailmind-sidebar .mailmind-spinner {
                width: 32px;
                height: 32px;
                border: 3px solid #90E0EF;
                border-top: 3px solid #0077B6;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 16px;
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            .mailmind-sidebar .mailmind-section {
                margin-bottom: 24px;
            }

            .mailmind-sidebar .mailmind-section:last-child {
                margin-bottom: 0;
            }

            .mailmind-sidebar .mailmind-section h4 {
                margin: 0 0 12px 0;
                color: #2d3748;
                font-size: 14px;
                font-weight: 600;
            }

            .mailmind-sidebar .mailmind-summary-text,
            .mailmind-sidebar .mailmind-reply-text {
                background: #f7fafc;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 14px;
                font-size: 14px;
                line-height: 1.5;
                color: #2d3748;
                margin-bottom: 12px;
            }

            .mailmind-sidebar .mailmind-reply-actions {
                display: flex;
                gap: 8px;
            }

            .mailmind-sidebar .mailmind-use-reply-btn,
            .mailmind-sidebar .mailmind-copy-reply-btn {
                flex: 1;
                padding: 10px 16px;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }

            .mailmind-sidebar .mailmind-use-reply-btn {
                background: #0077B6;
                color: white;
            }

            .mailmind-sidebar .mailmind-use-reply-btn:hover {
                background: #03045E;
            }

            .mailmind-sidebar .mailmind-copy-reply-btn {
                background: #edf2f7;
                color: #4a5568;
                border: 1px solid #e2e8f0;
            }

            .mailmind-sidebar .mailmind-copy-reply-btn:hover {
                background: #e2e8f0;
            }

            .mailmind-sidebar .mailmind-error {
                text-align: center;
                padding: 40px 20px;
            }

            .mailmind-sidebar .mailmind-error-icon {
                font-size: 32px;
                margin-bottom: 12px;
            }

            .mailmind-sidebar .mailmind-error h4 {
                color: #e53e3e;
                margin-bottom: 8px;
            }

            .mailmind-sidebar .mailmind-error p {
                color: #718096;
                font-size: 13px;
                line-height: 1.4;
            }

            /* Custom Reply Section Styles */
            .mailmind-sidebar .mailmind-custom-reply-section {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 16px;
            }

            .mailmind-sidebar .mailmind-custom-reply-hint {
                color: #64748b;
                font-size: 12px;
                margin: 0 0 12px 0;
                font-style: italic;
            }

            .mailmind-sidebar .mailmind-custom-input {
                width: 100%;
                padding: 10px;
                border: 1px solid #cbd5e0;
                border-radius: 6px;
                font-size: 13px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                resize: vertical;
                margin-bottom: 10px;
                box-sizing: border-box;
            }

            .mailmind-sidebar .mailmind-custom-input:focus {
                outline: none;
                border-color: #00B4D8;
                box-shadow: 0 0 0 3px rgba(0, 180, 216, 0.1);
            }

            .mailmind-sidebar .mailmind-generate-custom-btn {
                width: 100%;
                padding: 10px 16px;
                background: #0077B6;
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }

            .mailmind-sidebar .mailmind-generate-custom-btn:hover {
                background: #03045E;
            }

            .mailmind-sidebar .mailmind-generate-custom-btn:disabled {
                background: #9ca3af;
                cursor: not-allowed;
            }

            .mailmind-sidebar .mailmind-custom-reply-result {
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid #e2e8f0;
            }

            .mailmind-sidebar .mailmind-custom-reply-text {
                background: white;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 14px;
                font-size: 14px;
                line-height: 1.5;
                color: #2d3748;
                margin-bottom: 12px;
                white-space: pre-wrap;
            }

            .mailmind-sidebar .mailmind-use-custom-reply-btn,
            .mailmind-sidebar .mailmind-copy-custom-reply-btn {
                flex: 1;
                padding: 10px 16px;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }

            .mailmind-sidebar .mailmind-use-custom-reply-btn {
                background: #0077B6;
                color: white;
            }

            .mailmind-sidebar .mailmind-use-custom-reply-btn:hover {
                background: #03045E;
            }

            .mailmind-sidebar .mailmind-copy-custom-reply-btn {
                background: #edf2f7;
                color: #4a5568;
                border: 1px solid #e2e8f0;
            }

            .mailmind-sidebar .mailmind-copy-custom-reply-btn:hover {
                background: #e2e8f0;
            }

            @media (max-width: 500px) {
                .mailmind-sidebar {
                    right: 10px;
                    width: calc(100vw - 20px);
                    max-width: 350px;
                }
            }
        `;
        
        // Insert at the beginning of head to ensure it loads early
        document.head.insertBefore(styles, document.head.firstChild);
        console.log('MailMind: Single email sidebar styles added');
    }
}

// Initialize with error handling
try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => new GmailContentScript(), 1000);
        });
    } else {
        setTimeout(() => new GmailContentScript(), 1000);
    }
} catch (error) {
    console.error('MailMind: Failed to initialize content script:', error);
}