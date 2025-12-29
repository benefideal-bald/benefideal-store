// Support Chat Widget
(function() {
    'use strict';
    
    // Wait for DOM to be ready
    function initChat() {
        const chatWidget = document.getElementById('supportChatWidget');
        const chatToggle = document.getElementById('supportChatToggle');
        const chatWindow = document.getElementById('supportChatWindow');
        const chatClose = document.getElementById('supportChatClose');
        const chatMessages = document.getElementById('supportChatMessages');
        const chatInput = document.getElementById('supportChatInput');
        const chatSend = document.getElementById('supportChatSend');
        const fileInput = document.getElementById('supportChatFileInput');
        const chatBadge = document.getElementById('supportChatBadge');
        const chatInputArea = document.querySelector('.support-chat-input-area');
        
        // Check if all elements exist
        if (!chatWidget || !chatToggle || !chatWindow || !chatClose || !chatMessages || !chatInput || !chatSend || !fileInput || !chatBadge || !chatInputArea) {
            console.error('❌ Support chat elements not found:', {
                chatWidget: !!chatWidget,
                chatToggle: !!chatToggle,
                chatWindow: !!chatWindow,
                chatClose: !!chatClose,
                chatMessages: !!chatMessages,
                chatInput: !!chatInput,
                chatSend: !!chatSend,
                fileInput: !!fileInput,
                chatBadge: !!chatBadge,
                chatInputArea: !!chatInputArea
            });
            return;
        }
        
        console.log('✅ Support chat initialized');
    
    let isOpen = false;
    let messageHistory = [];
    let selectedFiles = []; // Array of files
    let selectedFilePreviews = []; // Array of previews
    
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
        
        // Welcome message (показываем только если нет истории сообщений)
        if (messageHistory.length === 0) {
            const welcome = document.createElement('div');
            welcome.className = 'support-chat-welcome';
            welcome.innerHTML = '<i class="fas fa-robot"></i><p>Здравствуйте! Чем могу помочь?</p>';
            chatMessages.appendChild(welcome);
        }
        
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
                    ${(msg.images || (msg.image ? [msg.image] : [])).map(img => `<img src="${img}" alt="Скриншот" class="support-chat-image">`).join('')}
                    <p>${escapeHtml(msg.text)}</p>
                    <span class="support-chat-time">${formatTime(msg.timestamp)}</span>
                </div>
            `;
        } else {
            const images = msg.images || [];
            div.innerHTML = `
                <div class="support-chat-message-content">
                    <i class="fas fa-headset"></i>
                    ${images.length > 0 ? images.map(filename => {
                        const imageUrl = `/uploads/support/${encodeURIComponent(filename)}`;
                        const escapedFilename = filename.replace(/'/g, "\\'");
                        return `<img src="${imageUrl}" alt="Изображение" class="support-chat-image" onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'200\' height=\'200\'%3E%3Crect width=\'200\' height=\'200\' fill=\'%23f3f4f6\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' text-anchor=\'middle\' dy=\'.3em\' fill=\'%239ca3af\' font-family=\'Arial\' font-size=\'14\'%3EИзображение%3C/text%3E%3C/svg%3E'; console.error('Failed to load image:', '${escapedFilename}');">
                    `;
                    }).join('') : ''}
                    ${msg.text ? `<p>${escapeHtml(msg.text)}</p>` : ''}
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
    async function sendMessage(text, imageFiles = null, imagePreviews = null) {
        // Support both single file (legacy) and array of files
        const files = Array.isArray(imageFiles) ? imageFiles : (imageFiles ? [imageFiles] : []);
        const previews = Array.isArray(imagePreviews) ? imagePreviews : (imagePreviews ? [imagePreviews] : []);
        
        if (!text.trim() && files.length === 0) return;
        
        const message = {
            type: 'user',
            text: text.trim(),
            images: previews, // Array of previews
            image: previews.length > 0 ? previews[0] : null, // Legacy support
            timestamp: Date.now()
        };
        
        messageHistory.push(message);
        saveHistory();
        renderMessages();
        
        // Clear input
        chatInput.value = '';
        chatInput.style.height = '40px'; // Reset textarea height
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
            
            // Append files if provided (support multiple files)
            if (files && files.length > 0) {
                files.forEach((file) => {
                    formData.append('images', file); // Use 'images' for multiple files
                });
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
                successDiv.innerHTML = '<div class="support-chat-message-content"><i class="fas fa-check-circle"></i><p>Сообщение отправлено! Осторожно, при обновлении страницы чат очищается.</p></div>';
                chatMessages.appendChild(successDiv);
                scrollToBottom();
                
                // Убеждаемся, что чат открыт и кликабелен
                if (isOpen) {
                    setTimeout(() => {
                        chatInput.focus();
                    }, 100);
                }
                
                // Save clientId for deletion on page unload
                if (data.clientId) {
                    currentClientId = data.clientId;
                    localStorage.setItem('support_client_id', data.clientId);
                }
                
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
    
    // Handle file input (multiple files support)
    fileInput.addEventListener('change', function(e) {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        // Check file sizes
        const invalidFiles = files.filter(file => file.size > 5 * 1024 * 1024);
        if (invalidFiles.length > 0) {
            alert(`Некоторые файлы превышают 5 МБ. Максимальный размер файла: 5 МБ`);
            fileInput.value = '';
            return;
        }
        
        // Find input area container - ensure we have the right parent
        if (!chatInputArea) {
            console.error('chatInputArea not found');
            return;
        }
        
        const inputAreaContainer = chatInputArea.closest('.support-chat-input-area');
        if (!inputAreaContainer) {
            console.error('inputAreaContainer not found');
            return;
        }
        
        // Find the parent container (support-chat-window)
        const chatWindow = document.getElementById('supportChatWindow');
        if (!chatWindow) {
            console.error('supportChatWindow not found');
            return;
        }
        
        // Use chatWindow as container for preview
        let previewContainer = chatWindow.querySelector('.support-chat-images-preview-container');
        if (!previewContainer) {
            previewContainer = document.createElement('div');
            previewContainer.className = 'support-chat-images-preview-container';
            previewContainer.style.cssText = 'padding: 8px; background: var(--gray-50, #f3f4f6); border-bottom: 1px solid var(--gray-200, #e5e7eb); width: 100%; display: flex; flex-wrap: wrap; gap: 8px;';
            // Insert before input area
            chatWindow.insertBefore(previewContainer, chatInputArea);
        }
        
        // Remove existing preview container if any
        let previewContainer = chatContent.querySelector('.support-chat-images-preview-container');
        if (!previewContainer) {
            previewContainer = document.createElement('div');
            previewContainer.className = 'support-chat-images-preview-container';
            previewContainer.style.cssText = 'padding: 8px; background: var(--gray-50, #f3f4f6); border-bottom: 1px solid var(--gray-200, #e5e7eb); width: 100%; display: flex; flex-wrap: wrap; gap: 8px;';
            // Insert before input area
            chatContent.insertBefore(previewContainer, chatInputArea);
        }
        
        // Process each file
        files.forEach((file) => {
            const fileIndex = selectedFiles.length;
            selectedFiles.push(file);
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const preview = e.target.result;
                selectedFilePreviews.push(preview);
                
                // Create preview item with green border
                const previewItem = document.createElement('div');
                previewItem.className = 'support-chat-image-preview-item';
                previewItem.dataset.index = fileIndex;
                previewItem.style.cssText = 'position: relative; display: inline-block;';
                previewItem.innerHTML = `
                    <img src="${preview}" alt="Превью" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; display: block; border: 2px solid #10b981; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);">
                    <button type="button" class="support-chat-remove-image" data-index="${fileIndex}" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 32px; height: 32px; background: rgba(220, 53, 69, 0.95); color: white; border: 2px solid white; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; padding: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.3); z-index: 10;" onclick="if (window.removeSelectedFileByIndex) { window.removeSelectedFileByIndex(${fileIndex}); }">
                        <i class="fas fa-times"></i>
                    </button>
                `;
                
                previewContainer.appendChild(previewItem);
            };
            reader.readAsDataURL(file);
        });
        
        // Clear file input to allow selecting same files again
        fileInput.value = '';
    });
    
    // Make remove function accessible globally for the remove button
    window.removeSelectedFile = function() {
        selectedFiles = [];
        selectedFilePreviews = [];
        fileInput.value = '';
        // Remove preview container if exists
        const previewContainer = document.querySelector('.support-chat-images-preview-container');
        if (previewContainer) {
            previewContainer.remove();
        }
    };
    
    // Remove file by index
    window.removeSelectedFileByIndex = function(index) {
        if (index >= 0 && index < selectedFiles.length) {
            selectedFiles.splice(index, 1);
            selectedFilePreviews.splice(index, 1);
            
            // Remove preview item
            const previewItem = document.querySelector(`.support-chat-image-preview-item[data-index="${index}"]`);
            if (previewItem) {
                previewItem.remove();
            }
            
            // Re-index remaining items
            const previewContainer = document.querySelector('.support-chat-images-preview-container');
            if (previewContainer) {
                const items = previewContainer.querySelectorAll('.support-chat-image-preview-item');
                items.forEach((item, newIndex) => {
                    item.dataset.index = newIndex;
                    const button = item.querySelector('.support-chat-remove-image');
                    if (button) {
                        button.dataset.index = newIndex;
                        button.setAttribute('onclick', `if (window.removeSelectedFileByIndex) { window.removeSelectedFileByIndex(${newIndex}); }`);
                    }
                });
            }
            
            // Remove container if empty
            if (selectedFiles.length === 0) {
                const previewContainer = document.querySelector('.support-chat-images-preview-container');
                if (previewContainer) {
                    previewContainer.remove();
                }
            }
        }
    };
    
    // Ensure chatInputArea is available
    if (!chatInputArea) {
        console.error('chatInputArea not found');
    }
    
    // Toggle chat
    chatToggle.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        isOpen = !isOpen;
        chatWindow.classList.toggle('open', isOpen);
        chatWidget.classList.toggle('open', isOpen);
        
        // Блокируем прокрутку body на мобильных (как корзина)
        if (window.innerWidth <= 768) {
            if (isOpen) {
                document.body.classList.add('chat-open');
            } else {
                document.body.classList.remove('chat-open');
            }
        }
        
        if (isOpen) {
            setTimeout(() => {
                chatInput.focus();
                scrollToBottom();
            }, 100);
            chatBadge.style.display = 'none';
        }
    });
    
    // Close chat
    chatClose.addEventListener('click', function() {
        isOpen = false;
        chatWindow.classList.remove('open');
        chatWidget.classList.remove('open');
        
        // Убираем блокировку прокрутки на мобильных
        if (window.innerWidth <= 768) {
            document.body.classList.remove('chat-open');
        }
    });
    
    // Закрываем чат при клике на overlay (только на мобильных, как корзина)
    chatWidget.addEventListener('click', function(e) {
        // Игнорируем клики на кнопку - она обрабатывается отдельно
        if (e.target === chatToggle || chatToggle.contains(e.target)) {
            return;
        }
        
        // На мобильных закрываем при клике на виджет (но не на окно)
        if (window.innerWidth <= 768 && isOpen) {
            // Проверяем, что клик был не на окно
            if (!chatWindow.contains(e.target)) {
                isOpen = false;
                chatWindow.classList.remove('open');
                chatWidget.classList.remove('open');
                document.body.classList.remove('chat-open');
            }
        }
    });
    
    // Предотвращаем закрытие при клике на само окно чата (но не блокируем клики по кнопкам внутри)
    chatWindow.addEventListener('click', function(e) {
        // Не блокируем клики по кнопкам и интерактивным элементам
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('label')) {
            return; // Позволяем кликам по кнопкам работать нормально
        }
        e.stopPropagation();
    });
    
    // Send button click
    chatSend.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const text = chatInput.value.trim();
        if (text || (selectedFiles && selectedFiles.length > 0)) {
            // Remove preview container if exists
            const previewContainer = document.querySelector('.support-chat-images-preview-container');
            if (previewContainer) {
                previewContainer.remove();
            }
            
            // Send message with all selected files
            sendMessage(text, selectedFiles.length > 0 ? selectedFiles : null, selectedFilePreviews.length > 0 ? selectedFilePreviews : null);
            
            // Clear file selection
            selectedFiles = [];
            selectedFilePreviews = [];
            fileInput.value = '';
        }
    });
    
    // Auto-resize textarea
    chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    });
    
    // Enter key to send (Shift+Enter for new line)
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (text || (selectedFiles && selectedFiles.length > 0)) {
                // Remove preview container if exists
                const previewContainer = document.querySelector('.support-chat-images-preview-container');
                if (previewContainer) {
                    previewContainer.remove();
                }
                
                // Send message with all selected files
                sendMessage(text, selectedFiles.length > 0 ? selectedFiles : null, selectedFilePreviews.length > 0 ? selectedFilePreviews : null);
                
                // Clear input and reset height
                chatInput.value = '';
                chatInput.style.height = 'auto';
                
                // Clear file selection
                selectedFiles = [];
                selectedFilePreviews = [];
                fileInput.value = '';
            }
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
                                images: reply.imageFilenames || [],
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
    
    // Store clientId for deletion on page unload
    let currentClientId = null;
    let chatDeleted = false; // Флаг, чтобы не удалять дважды
    
    // Function to delete chat when page is closed (NOT on reload)
    function deleteChatOnUnload() {
        // Проверяем, не удалили ли уже чат
        if (chatDeleted) {
            return;
        }
        chatDeleted = true;
        
        console.log('🗑️ Closing tab - deleting chat...');
        
        // Очищаем визуально чат сразу
        messageHistory = [];
        chatMessages.innerHTML = '';
        const welcome = document.createElement('div');
        welcome.className = 'support-chat-welcome';
        welcome.innerHTML = '<i class="fas fa-robot"></i><p>Здравствуйте! Чем могу помочь?</p>';
        chatMessages.appendChild(welcome);
        
        // Останавливаем все polling
        Object.keys(pollingIntervals).forEach(messageId => {
            clearInterval(pollingIntervals[messageId]);
        });
        pollingIntervals = {};
        
        // Очищаем localStorage
        localStorage.removeItem('support_chat_history');
        localStorage.removeItem('support_message_ids');
        localStorage.removeItem('support_client_id');
        
        // Отправляем запрос на удаление на сервере
        if (currentClientId) {
            const apiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
                ? `http://localhost:3000/api/support/delete-chat/${currentClientId}`
                : `${window.location.origin}/api/support/delete-chat/${currentClientId}`;
            
            // Use sendBeacon for reliable deletion even if page is closing
            if (navigator.sendBeacon) {
                // sendBeacon не поддерживает DELETE напрямую, используем fetch с keepalive
                fetch(apiUrl, {
                    method: 'DELETE',
                    keepalive: true
                }).catch(() => {
                    // Ignore errors - page is closing
                });
            } else {
                // Fallback to fetch with keepalive
                fetch(apiUrl, {
                    method: 'DELETE',
                    keepalive: true
                }).catch(() => {
                    // Ignore errors - page is closing
                });
            }
        }
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Используем ТОЛЬКО pagehide для определения закрытия вкладки
    // pagehide с persisted=false = закрытие вкладки (удаляем чат)
    // pagehide с persisted=true = обновление страницы/навигация (НЕ удаляем чат)
    window.addEventListener('pagehide', function(event) {
        // event.persisted === false означает, что страница НЕ сохраняется в кэше = закрытие вкладки
        // event.persisted === true означает, что страница сохраняется в кэше = обновление/навигация
        console.log('📄 pagehide event:', { persisted: event.persisted, type: event.persisted === false ? 'CLOSING TAB' : 'RELOAD/NAVIGATION' });
        if (event.persisted === false) {
            // Это закрытие вкладки - удаляем чат
            console.log('🗑️ Tab closing - deleting chat');
            deleteChatOnUnload();
        } else {
            // Это обновление страницы (F5, Ctrl+R) или навигация - НЕ удаляем чат
            console.log('🔄 Page reload/navigation detected (pagehide persisted=true) - KEEPING chat in localStorage');
            // КРИТИЧЕСКИ ВАЖНО: При обновлении страницы НЕ удаляем localStorage - чат должен сохраниться!
        }
    });
    
    // Load clientId from localStorage if exists
    currentClientId = localStorage.getItem('support_client_id');
    
    // КРИТИЧЕСКИ ВАЖНО: Загружаем историю из localStorage при обновлении страницы
    // История сохраняется автоматически при каждом сообщении через saveHistory()
    const savedHistory = localStorage.getItem('support_chat_history');
    const savedMessageIds = JSON.parse(localStorage.getItem('support_message_ids') || '[]');
    
    // Загружаем историю из localStorage (она сохраняется при каждом сообщении)
    if (savedHistory && savedHistory !== '[]') {
        try {
            const parsedHistory = JSON.parse(savedHistory);
            if (parsedHistory && parsedHistory.length > 0) {
                console.log('📥 Loading chat history from localStorage:', parsedHistory.length, 'messages');
                loadHistory();
                
                // Start polling for all messages in history that have messageId
                savedMessageIds.forEach(messageId => {
                    startPollingForReplies(messageId);
                });
            } else {
                // История пустая - показываем приветственное сообщение
                renderMessages();
            }
        } catch (e) {
            console.error('Error parsing saved history:', e);
            renderMessages();
        }
    } else {
        // Если нет истории, просто показываем приветственное сообщение
        renderMessages();
    }
    }
    
    // Initialize when DOM is ready
    function startInit() {
        console.log('🚀 Starting chat initialization...');
        try {
            initChat();
        } catch (error) {
            console.error('❌ Error initializing chat:', error);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startInit);
    } else {
        // DOM is already ready
        startInit();
    }
})();

