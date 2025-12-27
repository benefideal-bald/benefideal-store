// Support Chat Widget
(function() {
    'use strict';
    
    const chatWidget = document.getElementById('supportChatWidget');
    const chatToggle = document.getElementById('supportChatToggle');
    const chatWindow = document.getElementById('supportChatWindow');
    const chatClose = document.getElementById('supportChatClose');
    const chatMessages = document.getElementById('supportChatMessages');
    const chatInput = document.getElementById('supportChatInput');
    const chatSend = document.getElementById('supportChatSend');
    const fileInput = document.getElementById('supportChatFileInput');
    const chatBadge = document.getElementById('supportChatBadge');
    
    let isOpen = false;
    let messageHistory = [];
    
    // Load message history from localStorage
    function loadHistory() {
        try {
            const saved = localStorage.getItem('support_chat_history');
            if (saved) {
                messageHistory = JSON.parse(saved);
                renderMessages();
            }
        } catch (e) {
            console.error('Error loading chat history:', e);
        }
    }
    
    // Save message history to localStorage
    function saveHistory() {
        try {
            localStorage.setItem('support_chat_history', JSON.stringify(messageHistory));
        } catch (e) {
            console.error('Error saving chat history:', e);
        }
    }
    
    // Render messages
    function renderMessages() {
        chatMessages.innerHTML = '';
        
        // Welcome message
        const welcome = document.createElement('div');
        welcome.className = 'support-chat-welcome';
        welcome.innerHTML = '<i class="fas fa-robot"></i><p>Здравствуйте! Чем могу помочь?</p>';
        chatMessages.appendChild(welcome);
        
        // Render history
        messageHistory.forEach(msg => {
            const messageDiv = createMessageElement(msg);
            chatMessages.appendChild(messageDiv);
        });
        
        scrollToBottom();
    }
    
    // Create message element
    function createMessageElement(msg) {
        const div = document.createElement('div');
        div.className = `support-chat-message ${msg.type}`;
        
        if (msg.type === 'user') {
            div.innerHTML = `
                <div class="support-chat-message-content">
                    ${msg.image ? `<img src="${msg.image}" alt="Скриншот" class="support-chat-image">` : ''}
                    <p>${escapeHtml(msg.text)}</p>
                    <span class="support-chat-time">${formatTime(msg.timestamp)}</span>
                </div>
            `;
        } else {
            div.innerHTML = `
                <div class="support-chat-message-content">
                    <i class="fas fa-headset"></i>
                    <p>${escapeHtml(msg.text)}</p>
                    <span class="support-chat-time">${formatTime(msg.timestamp)}</span>
                </div>
            `;
        }
        
        return div;
    }
    
    // Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Format time
    function formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'только что';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
        
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    
    // Scroll to bottom
    function scrollToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Send message
    async function sendMessage(text, imageFile = null, imagePreview = null) {
        if (!text.trim() && !imageFile) return;
        
        const message = {
            type: 'user',
            text: text.trim(),
            image: imagePreview,
            timestamp: Date.now()
        };
        
        messageHistory.push(message);
        saveHistory();
        renderMessages();
        
        // Clear input
        chatInput.value = '';
        fileInput.value = '';
        
        // Show sending indicator
        const sendingDiv = document.createElement('div');
        sendingDiv.className = 'support-chat-message support';
        sendingDiv.innerHTML = '<div class="support-chat-message-content"><i class="fas fa-headset"></i><p>Отправка...</p></div>';
        chatMessages.appendChild(sendingDiv);
        scrollToBottom();
        
        try {
            // Determine API URL
            const apiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
                ? 'http://localhost:3000/api/support/send-message'
                : `${window.location.origin}/api/support/send-message`;
            
            const formData = new FormData();
            formData.append('message', text.trim());
            
            // Append file if provided
            if (imageFile) {
                formData.append('image', imageFile);
            }
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            // Remove sending indicator
            sendingDiv.remove();
            
            if (data.success) {
                // Show success message
                const successDiv = document.createElement('div');
                successDiv.className = 'support-chat-message support';
                successDiv.innerHTML = '<div class="support-chat-message-content"><i class="fas fa-check-circle"></i><p>Сообщение отправлено! Мы ответим вам в ближайшее время.</p></div>';
                chatMessages.appendChild(successDiv);
                scrollToBottom();
                
                // Start polling for replies if messageId is provided
                if (data.messageId) {
                    // Save messageId to localStorage
                    const savedMessageIds = JSON.parse(localStorage.getItem('support_message_ids') || '[]');
                    if (!savedMessageIds.includes(data.messageId)) {
                        savedMessageIds.push(data.messageId);
                        localStorage.setItem('support_message_ids', JSON.stringify(savedMessageIds));
                    }
                    
                    startPollingForReplies(data.messageId);
                }
            } else {
                throw new Error(data.error || 'Ошибка отправки');
            }
        } catch (error) {
            console.error('Error sending message:', error);
            sendingDiv.remove();
            
            const errorDiv = document.createElement('div');
            errorDiv.className = 'support-chat-message support error';
            errorDiv.innerHTML = '<div class="support-chat-message-content"><i class="fas fa-exclamation-circle"></i><p>Ошибка отправки. Попробуйте еще раз.</p></div>';
            chatMessages.appendChild(errorDiv);
            scrollToBottom();
        }
    }
    
    // Handle file input
    fileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            if (file.size > 5 * 1024 * 1024) {
                alert('Размер файла не должен превышать 5 МБ');
                fileInput.value = '';
                return;
            }
            
            // Show image preview
            const reader = new FileReader();
            reader.onload = function(e) {
                const imageData = e.target.result;
                sendMessage('', file, imageData);
            };
            reader.readAsDataURL(file);
        }
    });
    
    // Toggle chat
    chatToggle.addEventListener('click', function() {
        isOpen = !isOpen;
        chatWindow.classList.toggle('open', isOpen);
        chatWidget.classList.toggle('open', isOpen);
        
        if (isOpen) {
            chatInput.focus();
            scrollToBottom();
            chatBadge.style.display = 'none';
        }
    });
    
    // Close chat
    chatClose.addEventListener('click', function() {
        isOpen = false;
        chatWindow.classList.remove('open');
        chatWidget.classList.remove('open');
    });
    
    // Send button click
    chatSend.addEventListener('click', function() {
        sendMessage(chatInput.value);
    });
    
    // Enter key to send
    chatInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(chatInput.value);
        }
    });
    
    // Polling for replies
    let pollingIntervals = {};
    
    function startPollingForReplies(messageId) {
        // Stop existing polling for this message
        if (pollingIntervals[messageId]) {
            clearInterval(pollingIntervals[messageId]);
        }
        
        // Poll every 3 seconds
        pollingIntervals[messageId] = setInterval(async () => {
            try {
                const apiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
                    ? `http://localhost:3000/api/support/check-replies/${messageId}`
                    : `${window.location.origin}/api/support/check-replies/${messageId}`;
                
                const response = await fetch(apiUrl);
                const data = await response.json();
                
                if (data.success && data.replies && data.replies.length > 0) {
                    // Check which replies are new
                    const existingTimestamps = messageHistory
                        .filter(m => m.type === 'support' && m.timestamp)
                        .map(m => m.timestamp);
                    
                    data.replies.forEach(reply => {
                        if (!existingTimestamps.includes(reply.timestamp)) {
                            // New reply - add to history
                            const replyMessage = {
                                type: 'support',
                                text: reply.text,
                                timestamp: reply.timestamp
                            };
                            
                            messageHistory.push(replyMessage);
                            saveHistory();
                            renderMessages();
                            
                            // Show notification if chat is closed
                            if (!isOpen) {
                                chatBadge.style.display = 'flex';
                            }
                        }
                    });
                }
            } catch (error) {
                console.error('Error polling for replies:', error);
            }
        }, 3000);
    }
    
    // Load history on init
    loadHistory();
    
    // Start polling for all messages in history that have messageId
    const savedMessageIds = JSON.parse(localStorage.getItem('support_message_ids') || '[]');
    savedMessageIds.forEach(messageId => {
        startPollingForReplies(messageId);
    });
})();

