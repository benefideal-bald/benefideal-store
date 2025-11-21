// Products data
const subscriptions = [
    {
        id: 1,
        title: "Chat-GPT Plus",
        description: "Премиум доступ к Chat-GPT с приоритетом и расширенными возможностями",
        price: 1900,
        originalPrice: 2999,
        icon: "fas fa-robot",
        category: "ai"
    },
    {
        id: 3,
        title: "Adobe Creative Cloud",
        description: "Полный набор профессиональных инструментов Adobe для творчества",
        price: 3400,
        originalPrice: 5999,
        icon: "fas fa-cloud",
        category: "design"
    },
    {
        id: 7,
        title: "CapCut Pro",
        description: "Профессиональное мобильное приложение для видеомонтажа и создания контента",
        price: 1200,
        originalPrice: 1999,
        icon: "fas fa-video",
        category: "video"
    }
];

// Cart data
let cart = [];

// Load cart from localStorage
function loadCart() {
    try {
        const savedCart = localStorage.getItem('benefideal_cart');
        const cartTimestamp = localStorage.getItem('benefideal_cart_timestamp');
        
        if (savedCart && cartTimestamp) {
            const now = new Date().getTime();
            const savedTime = parseInt(cartTimestamp);
            const daysDiff = (now - savedTime) / (1000 * 60 * 60 * 24);
            
            // If cart is older than 30 days, clear it
            if (daysDiff > 30) {
                localStorage.removeItem('benefideal_cart');
                localStorage.removeItem('benefideal_cart_timestamp');
                cart = [];
                updateCartUI();
                showNotification('Корзина была очищена (срок хранения 30 дней истек)', 'info');
                return;
            }
            
            const parsedCart = JSON.parse(savedCart);
            if (Array.isArray(parsedCart)) {
                cart = parsedCart;
                console.log('Cart loaded:', cart.length, 'items');
                updateCartUI();
                
                // Show remaining days info
                const remainingDays = Math.ceil(30 - daysDiff);
                if (remainingDays <= 7) {
                    showNotification(`Корзина будет сохранена еще ${remainingDays} дней`, 'info');
                }
            } else {
                console.error('Invalid cart data in localStorage');
                cart = [];
                updateCartUI();
            }
        } else {
            // No saved cart, keep current cart or initialize empty
            if (cart.length === 0) {
                cart = [];
            }
            updateCartUI();
        }
    } catch (e) {
        console.error('Error loading cart from localStorage:', e);
        cart = [];
        updateCartUI();
    }
}

// Make loadCart available globally for reviews.html
window.loadCart = loadCart;

// Save cart to localStorage
function saveCart() {
    try {
        const now = new Date().getTime();
        localStorage.setItem('benefideal_cart', JSON.stringify(cart));
        localStorage.setItem('benefideal_cart_timestamp', now.toString());
        console.log('Cart saved:', cart.length, 'items');
    } catch (e) {
        console.error('Error saving cart to localStorage:', e);
    }
}

// DOM elements
const cartModal = document.getElementById('cartModal');
const cartItems = document.getElementById('cartItems');
const cartCount = document.getElementById('cartCount');
const cartTotal = document.getElementById('cartTotal');
const subscriptionsGrid = document.getElementById('subscriptionsGrid');

// Initialize app
function initializeApp() {
    // Clear any existing notifications first
    const existingNotifications = document.querySelectorAll('.notification, .cart-notification');
    existingNotifications.forEach(notif => notif.remove());
    
    loadCart();
    updateCartUI(); // Always update cart UI first
    
    // Only run these if elements exist (for main page)
    if (subscriptionsGrid) {
        renderSubscriptions();
    }
    
    setupEventListeners();
    
    // Only run these if elements exist
    initAnimations();
    initScrollAnimations();
    
    if (document.querySelector('.hero')) {
        initParticles();
    }
    
    if (document.getElementById('reviewsWrapper') || document.querySelector('.reviews-wrapper')) {
        initReviewsAutoScroll();
    }
    
    setupSubscriptionOptions();
    
    // Прокрутка к якорю при загрузке страницы (если есть в URL)
    // Это нужно для плавной прокрутки при переходе с других страниц
    handleAnchorScroll();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initializeApp);

// Also initialize when page is restored from cache (back/forward navigation)
window.addEventListener('pageshow', function(event) {
    // Clear any existing notifications first
    const existingNotifications = document.querySelectorAll('.notification, .cart-notification');
    existingNotifications.forEach(notif => notif.remove());
    
    // Always reload cart when page is shown (both from cache and normal navigation)
    loadCart();
    updateCartUI();
    
    // Убираем focus с навигационных ссылок после перехода на страницу
    // Это предотвращает появление фиолетовой полосы после клика
    const navLinks = document.querySelectorAll('.nav-links a, .mobile-nav-links a');
    navLinks.forEach(link => {
        if (document.activeElement === link) {
            link.blur();
        }
    });
    
    // Прокрутка к якорю при восстановлении страницы из кеша
    handleAnchorScroll();
});

// Убираем focus с навигационных ссылок после клика (чтобы фиолетовая полоса не оставалась)
document.addEventListener('click', function(e) {
    if (e.target.closest('.nav-links a, .mobile-nav-links a')) {
        const link = e.target.closest('a');
        // Небольшая задержка, чтобы переход успел произойти
        setTimeout(() => {
            if (link && document.activeElement === link) {
                link.blur();
            }
        }, 100);
    }
});

// Also reload cart when page becomes visible (in case of tab switching)
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Clear any existing notifications first
        const existingNotifications = document.querySelectorAll('.notification, .cart-notification');
        existingNotifications.forEach(notif => notif.remove());
        
        loadCart();
        updateCartUI();
    }
});

// Setup event listeners
function setupEventListeners() {
    // Cart modal
    cartModal.addEventListener('click', function(e) {
        if (e.target === cartModal) {
            toggleCart();
        }
    });
    
    // Header scroll effect
    window.addEventListener('scroll', handleScroll);
    
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const href = this.getAttribute('href');
            const target = document.querySelector(href);
            if (target) {
                const headerHeight = document.querySelector('.header')?.offsetHeight || 80;
                const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - headerHeight;
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
    
}

// Handle scroll effects
function handleScroll() {
    const header = document.querySelector('.header');
    if (window.scrollY > 100) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }
}

// Функция для обработки прокрутки к якорю при загрузке страницы
function handleAnchorScroll() {
    // Проверяем, есть ли якорь в URL
    const hash = window.location.hash;
    if (hash) {
        // Небольшая задержка, чтобы страница успела загрузиться
        setTimeout(() => {
            const target = document.querySelector(hash);
            if (target) {
                const headerHeight = document.querySelector('.header')?.offsetHeight || 80;
                const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - headerHeight;
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        }, 100);
    }
}

// Initialize animations
function initAnimations() {
    // Animate cards on load
    const cards = document.querySelectorAll('.subscription-card');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        
        setTimeout(() => {
            card.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 100);
    });

    // Animate benefit cards
    const benefitCards = document.querySelectorAll('.benefit-card');
    benefitCards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        
        setTimeout(() => {
            card.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, 400 + (index * 150));
    });

    // Animate review cards
    const reviewCards = document.querySelectorAll('.review-card');
    reviewCards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        
        setTimeout(() => {
            card.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, 600 + (index * 100));
    });
}

// Initialize scroll animations
function initScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -100px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    // Observe elements
    const animatedElements = document.querySelectorAll(
        '.workflow-step, .social-link, .feature-card, .subscription-card, .benefit-card, .review-card'
    );
    
    animatedElements.forEach(el => {
        observer.observe(el);
    });
}

// Initialize particles effect (simple version)
function initParticles() {
    const hero = document.querySelector('.hero');
    if (!hero) return;
    
    // Create floating particles
    for (let i = 0; i < 20; i++) {
        const particle = document.createElement('div');
        particle.style.position = 'absolute';
        particle.style.width = Math.random() * 6 + 2 + 'px';
        particle.style.height = particle.style.width;
        particle.style.background = 'rgba(255, 255, 255, 0.3)';
        particle.style.borderRadius = '50%';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animation = `float ${Math.random() * 10 + 10}s ease-in-out infinite`;
        particle.style.animationDelay = Math.random() * 5 + 's';
        particle.style.pointerEvents = 'none';
        
        hero.appendChild(particle);
    }
}

// Initialize reviews auto-scroll
let carouselAnimation = null;

function initReviewsAutoScroll() {
    // Try both ID and class selector for compatibility
    const reviewsWrapper = document.getElementById('reviewsWrapper') || document.querySelector('.reviews-wrapper');
    if (!reviewsWrapper) {
        console.log('Reviews wrapper not found');
        return;
    }
    
    // Stop existing animation if any
    if (carouselAnimation) {
        cancelAnimationFrame(carouselAnimation);
        carouselAnimation = null;
    }
    
    // Remove any existing clones
    const existingClones = reviewsWrapper.querySelectorAll('.review-card[data-is-clone="true"]');
    existingClones.forEach(clone => clone.remove());

    // Get all original cards in their current order (newest first)
    // DO NOT reorder them - they are already in the correct order!
    const reviewCards = reviewsWrapper.querySelectorAll('.review-card:not([data-is-clone="true"])');
    if (reviewCards.length === 0) {
        console.log('No review cards found');
        return;
    }
    
    console.log('Initializing carousel with', reviewCards.length, 'cards');
    console.log('First card (newest):', reviewCards[0].querySelector('.review-name')?.textContent);
    
    // Calculate width of all original cards
    const cardWidth = reviewCards[0].offsetWidth;
    const gap = 24; // var(--space-6) = 1.5rem = 24px
    const originalCardCount = reviewCards.length;
    const oneSetWidth = (cardWidth * originalCardCount) + (gap * (originalCardCount - 1));
    
    // Clone all cards for seamless infinite scroll (preserve order)
    reviewCards.forEach((card) => {
        const clone = card.cloneNode(true);
        clone.setAttribute('data-is-clone', 'true');
        reviewsWrapper.appendChild(clone);
    });

    let scrollPosition = 0;
    let lastTimestamp = 0;
    const scrollSpeed = 80; // pixels per second

    function animateScroll(timestamp) {
        if (!lastTimestamp) lastTimestamp = timestamp;
        const deltaTime = timestamp - lastTimestamp;
        lastTimestamp = timestamp;

        scrollPosition += scrollSpeed * (deltaTime / 1000);
        
        if (scrollPosition >= oneSetWidth) {
            scrollPosition = scrollPosition - oneSetWidth;
        }
        
        reviewsWrapper.style.transform = `translate3d(-${scrollPosition.toFixed(2)}px, 0, 0)`;

        carouselAnimation = requestAnimationFrame(animateScroll);
    }

    // Reset transform before starting
    reviewsWrapper.style.transform = 'translate3d(0, 0, 0)';
    scrollPosition = 0;
    lastTimestamp = 0;
    
    carouselAnimation = requestAnimationFrame(animateScroll);
    console.log('Carousel animation started with', originalCardCount, 'original cards (order preserved)');
}

// Toggle cart modal
function toggleCart() {
    const cartModalElement = document.getElementById('cartModal');
    if (!cartModalElement) {
        console.error('Cart modal not found!');
        return;
    }
    
    const isOpening = !cartModalElement.classList.contains('active');
    cartModalElement.classList.toggle('active');
    
    // Block/unblock body scroll
    if (isOpening) {
        document.body.classList.add('cart-open');
        // Save current scroll position
        const scrollY = window.scrollY;
        document.body.style.top = `-${scrollY}px`;
    } else {
        document.body.classList.remove('cart-open');
        // Restore scroll position
        const scrollY = document.body.style.top;
        document.body.style.top = '';
        if (scrollY) {
            window.scrollTo(0, parseInt(scrollY || '0') * -1);
        }
    }
    
    // Add animation class
    if (cartModalElement.classList.contains('active')) {
        const cartContent = document.querySelector('.cart-content');
        if (cartContent) {
            cartContent.style.animation = 'scaleIn 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        }
        // Update cart UI when opening
        updateCartUI();
    }
}

// Make toggleCart available globally
window.toggleCart = toggleCart;

// Render subscriptions
function renderSubscriptions() {
    if (!subscriptionsGrid) return;
    
    subscriptionsGrid.innerHTML = subscriptions.map(subscription => 
        createSubscriptionCard(subscription)
    ).join('');
}

// Create subscription card
function createSubscriptionCard(subscription) {
    const pageMap = {
        1: 'chatgpt.html',
        3: 'adobe.html',
        7: 'capcut.html'
    };
    
    return `
        <a href="${pageMap[subscription.id]}" class="subscription-card">
            <div>
                <div class="subscription-icon">
                    <i class="${subscription.icon}"></i>
                </div>
                <h3 class="subscription-title">${subscription.title}</h3>
                <p class="subscription-description">${subscription.description}</p>
                <div class="subscription-price">
                    ${subscription.price.toLocaleString()} ₽
                    <span class="subscription-original-price">${subscription.originalPrice.toLocaleString()} ₽</span>
                </div>
            </div>
        </a>
    `;
}

// Add to cart with animation
function addToCart(subscriptionId) {
    const subscription = subscriptions.find(s => s.id === subscriptionId);
    if (subscription) {
        // Get selected duration from radio buttons
        let selectedDuration = null;
        const durationInputs = document.querySelectorAll('input[name^="duration"]:checked');
        if (durationInputs.length > 0) {
            selectedDuration = parseInt(durationInputs[0].value);
        }
        
        // Calculate price based on duration
        const calculatedPrice = calculatePrice(subscriptionId, selectedDuration);
        
        // Check if item with same ID and duration exists
        const existingItem = cart.find(item => item.id === subscriptionId && item.months === selectedDuration);
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            cart.push({
                ...subscription,
                price: calculatedPrice,
                quantity: 1,
                months: selectedDuration
            });
        }
        
        // Save cart to localStorage
        saveCart();
        
        // Force update cart UI
        updateCartUI();
        
        // Animate cart icon
        const cartBtn = document.querySelector('.cart-toggle');
        if (cartBtn) {
            cartBtn.style.animation = 'bounce 0.6s ease';
        }
        
        // Force show cart count
        const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
        const cartCountElement = document.getElementById('cartCount');
        if (cartCountElement) {
            cartCountElement.textContent = totalItems;
            cartCountElement.style.display = 'flex';
            cartCountElement.style.background = '#ff4444';
            cartCountElement.style.color = 'white';
            cartCountElement.style.position = 'absolute';
            cartCountElement.style.top = '-8px';
            cartCountElement.style.right = '-8px';
            cartCountElement.style.borderRadius = '50%';
            cartCountElement.style.minWidth = '20px';
            cartCountElement.style.height = '20px';
            cartCountElement.style.alignItems = 'center';
            cartCountElement.style.justifyContent = 'center';
            cartCountElement.style.fontSize = '0.7rem';
            cartCountElement.style.fontWeight = '700';
            cartCountElement.style.zIndex = '10';
            cartCountElement.style.border = '2px solid white';
            cartCountElement.style.animation = 'bounce 0.5s ease';
            console.log('Cart count should be visible:', totalItems);
        } else {
            console.error('Cart count element not found!');
        }
        
        // Automatically open cart modal
        setTimeout(() => {
            toggleCart();
        }, 300);
        setTimeout(() => {
            cartBtn.style.animation = '';
        }, 600);
    }
}

// Remove from cart
function removeFromCart(subscriptionId) {
    cart = cart.filter(item => item.id !== subscriptionId);
    saveCart();
    updateCartUI();
    
    // Force hide cart count if empty
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const cartCountElement = document.getElementById('cartCount');
    if (cartCountElement && totalItems === 0) {
        cartCountElement.style.display = 'none';
    }
}

// Update cart quantity
function updateCartQuantity(subscriptionId, quantity) {
    const item = cart.find(item => item.id === subscriptionId);
    if (item) {
        if (quantity <= 0) {
            removeFromCart(subscriptionId);
        } else {
            item.quantity = quantity;
            saveCart();
            updateCartUI();
        }
    }
}

// Update cart quantity by index
function updateCartQuantityByIndex(index, quantity) {
    if (index >= 0 && index < cart.length) {
        if (quantity <= 0) {
            removeFromCartByIndex(index);
        } else {
            cart[index].quantity = quantity;
            saveCart();
            updateCartUI();
        }
    }
}

// Remove from cart by index
function removeFromCartByIndex(index) {
    if (index >= 0 && index < cart.length) {
        cart.splice(index, 1);
        saveCart();
        updateCartUI();
        
        // Force hide cart count if empty
        const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
        const cartCountElement = document.getElementById('cartCount');
        if (cartCountElement && totalItems === 0) {
            cartCountElement.style.display = 'none';
        }
    }
}

// Update cart UI
function updateCartUI() {
    // Update cart count
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    
    // Find cart count element
    const cartCountElement = document.getElementById('cartCount');
    
    if (cartCountElement) {
        cartCountElement.textContent = totalItems;
        // Show/hide cart count badge
        if (totalItems > 0) {
            cartCountElement.style.display = 'flex';
            cartCountElement.style.background = '#ff4444';
            cartCountElement.style.color = 'white';
            cartCountElement.style.position = 'absolute';
            cartCountElement.style.top = '-8px';
            cartCountElement.style.right = '-8px';
            cartCountElement.style.borderRadius = '50%';
            cartCountElement.style.minWidth = '20px';
            cartCountElement.style.height = '20px';
            cartCountElement.style.alignItems = 'center';
            cartCountElement.style.justifyContent = 'center';
            cartCountElement.style.fontSize = '0.7rem';
            cartCountElement.style.fontWeight = '700';
            cartCountElement.style.zIndex = '10';
            cartCountElement.style.border = '2px solid white';
            cartCountElement.style.animation = 'bounce 0.5s ease';
        } else {
            cartCountElement.style.display = 'none';
        }
    } else {
        // Если элемент не найден, пробуем найти его позже (для страницы отзывов)
        console.warn('Cart count element not found, will retry...');
        setTimeout(function() {
            const retryElement = document.getElementById('cartCount');
            if (retryElement) {
                updateCartUI();
            }
        }, 100);
    }
    

    // Update cart items (only if cartModal exists - for main page)
    if (cartItems && cartModal && cartTotal) {
        if (cart.length === 0) {
            cartItems.innerHTML = `
                <div style="text-align: center; padding: 2rem; color: var(--light-gray);">
                    <i class="fas fa-shopping-cart" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i>
                    <p>Корзина пуста</p>
                </div>
            `;
            cartTotal.textContent = '0';
        } else {
            cartItems.innerHTML = cart.map((item, index) => {
            // Format duration text
            let durationText = '';
            if (item.months) {
                if (item.months === 1) {
                    durationText = '1 месяц';
                } else if (item.months >= 2 && item.months <= 4) {
                    durationText = `${item.months} месяца`;
                } else {
                    durationText = `${item.months} месяцев`;
                }
            }
            
            return `
            <div class="cart-item">
                <div>
                    <h4>${item.title}</h4>
                    <p>${item.price.toLocaleString()} ₽${durationText ? ` • ${durationText}` : ''}${item.quantity > 1 ? ` × ${item.quantity}` : ''}</p>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <button onclick="updateCartQuantityByIndex(${index}, ${item.quantity - 1})" 
                            style="background: var(--gradient-primary); color: white; border: none; border-radius: 6px; width: 32px; height: 32px; cursor: pointer; transition: all 0.3s ease; font-weight: 600;">
                        -
                    </button>
                    <span style="font-weight: 600; min-width: 20px; text-align: center;">${item.quantity}</span>
                    <button onclick="updateCartQuantityByIndex(${index}, ${item.quantity + 1})" 
                            style="background: var(--gradient-primary); color: white; border: none; border-radius: 6px; width: 32px; height: 32px; cursor: pointer; transition: all 0.3s ease; font-weight: 600;">
                        +
                    </button>
                    <button onclick="removeFromCartByIndex(${index})" 
                            style="background: none; border: none; color: var(--secondary); cursor: pointer; margin-left: 10px; font-size: 1.1rem; transition: all 0.3s ease;">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
            }).join('');

            // Update total
            const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            cartTotal.textContent = total.toLocaleString();
        }
    }
}

// Make updateCartUI available globally for reviews.html
window.updateCartUI = updateCartUI;

// Clear cart after successful purchase
function clearCartAfterPurchase() {
    cart = [];
    localStorage.removeItem('benefideal_cart');
    localStorage.removeItem('benefideal_cart_timestamp');
    updateCartUI();
    showNotification('Заказ успешно оформлен! Корзина очищена.', 'success');
}

// Checkout
function checkout() {
    if (cart.length === 0) {
        showNotification('Корзина пуста', 'error');
        return;
    }
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    showNotification(`Переход к оплате на сумму ${total.toLocaleString()} ₽`, 'success');
    
    // Redirect to checkout page with form
    setTimeout(() => {
        window.location.href = 'checkout.html';
    }, 400);
}

// Make checkout available globally
window.checkout = checkout;

// Show notification from cart
function showCartNotification(message) {
    // Remove existing cart notification
    const existing = document.querySelector('.cart-notification');
    if (existing) {
        existing.remove();
    }
    
    // Get cart button position
    const cartBtn = document.querySelector('.cart-toggle');
    if (!cartBtn) return;
    
    const cartRect = cartBtn.getBoundingClientRect();
    
    // Create notification
    const notification = document.createElement('div');
    notification.className = 'cart-notification';
    notification.textContent = message;
    
    // Calculate position - ensure it's below header (60px) with some margin
    const headerHeight = 60;
    const marginTop = 10;
    const notificationTop = Math.max(cartRect.top + marginTop, headerHeight + marginTop);
    
    notification.style.cssText = `
        position: fixed;
        top: ${notificationTop}px;
        right: ${cartRect.right - 200}px;
        background: var(--gradient-primary);
        color: white;
        padding: 0.8rem 1.2rem;
        border-radius: 8px;
        box-shadow: var(--shadow-colored);
        z-index: 10000;
        animation: slideInFromCart 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        font-weight: 600;
        font-size: 0.9rem;
        max-width: 200px;
        text-align: center;
        pointer-events: none;
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 2 seconds
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.5s ease';
        setTimeout(() => {
            notification.remove();
        }, 500);
    }, 2000);
}

// Show notification
function showNotification(message, type = 'success') {
    // Remove existing notification
    const existing = document.querySelector('.notification');
    if (existing) {
        existing.remove();
    }
    
    // Create notification
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? 'var(--gradient-primary)' : 'var(--gradient-secondary)'};
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 12px;
        box-shadow: var(--shadow-colored);
        z-index: 10000;
        animation: slideInRight 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        font-weight: 600;
        max-width: 300px;
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.5s ease';
        setTimeout(() => {
            notification.remove();
        }, 500);
    }, 3000);
}

// Add CSS for notification animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            opacity: 0;
            transform: translateX(100px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    
    @keyframes slideInFromCart {
        from {
            opacity: 0;
            transform: translateY(20px) scale(0.8);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
    
    @keyframes fadeOut {
        from {
            opacity: 1;
        }
        to {
            opacity: 0;
            transform: translateY(-20px);
        }
    }
    
    .animate-in {
        animation: fadeInUp 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    
    /* Add hover effects to buttons */
    button:hover {
        transform: scale(1.05);
    }
    
    /* Smooth transitions */
    * {
        transition: background-color 0.3s ease, color 0.3s ease;
    }
`;
document.head.appendChild(style);

// Add cursor trail effect (optional, for extra flair)
function initCursorTrail() {
    let mouseX = 0;
    let mouseY = 0;
    
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });
    
    setInterval(() => {
        const trail = document.createElement('div');
        trail.style.cssText = `
            position: fixed;
            width: 10px;
            height: 10px;
            background: var(--gradient-primary);
            border-radius: 50%;
            pointer-events: none;
            z-index: 9999;
            opacity: 0.5;
            left: ${mouseX}px;
            top: ${mouseY}px;
            transform: translate(-50%, -50%);
            animation: trailFade 1s ease forwards;
        `;
        
        document.body.appendChild(trail);
        
        setTimeout(() => {
            trail.remove();
        }, 1000);
    }, 50);
}

// Add trail animation
const trailStyle = document.createElement('style');
trailStyle.textContent = `
    @keyframes trailFade {
        to {
            opacity: 0;
            transform: translate(-50%, -50%) scale(2);
        }
    }
`;
document.head.appendChild(trailStyle);

// Optionally initialize cursor trail (comment out if too much)
// initCursorTrail();

// Get price data structure (for both display and calculation)
function getPriceData() {
    return {
        'chatgpt': {
            '1': { current: '1,900 ₽', original: '2,999 ₽', discount: '-37%', numericPrice: 1900 },
            '3': { current: '5,415 ₽', original: '8,100 ₽', discount: '-33%', numericPrice: 5415 },
            '6': { current: '10,260 ₽', original: '15,300 ₽', discount: '-33%', numericPrice: 10260 },
            '12': { current: '18,240 ₽', original: '27,360 ₽', discount: '-33%', numericPrice: 18240 }
        },
        'adobe': {
            '1': { current: '3,400 ₽', original: '5,999 ₽', discount: '-43%', numericPrice: 3400 },
            '3': { current: '9,400 ₽', original: '16,000 ₽', discount: '-41%', numericPrice: 9400 },
            '6': { current: '17,810 ₽', original: '30,000 ₽', discount: '-41%', numericPrice: 17810 },
            '12': { current: '29,700 ₽', original: '50,000 ₽', discount: '-41%', numericPrice: 29700 }
        },
        'capcut': {
            '1': { current: '1,200 ₽', original: '1,999 ₽', discount: '-40%', numericPrice: 1200 },
            '3': { current: '3,315 ₽', original: '5,400 ₽', discount: '-39%', numericPrice: 3315 },
            '6': { current: '6,060 ₽', original: '10,200 ₽', discount: '-41%', numericPrice: 6060 },
            '12': { current: '9,840 ₽', original: '18,000 ₽', discount: '-45%', numericPrice: 9840 }
        }
    };
}

// Calculate price based on product ID and duration
function calculatePrice(productId, duration) {
    const priceData = getPriceData();
    const durationKey = duration ? duration.toString() : '1';
    
    // Map product ID to key
    const productKeyMap = {
        1: 'chatgpt',
        3: 'adobe',
        7: 'capcut'
    };
    
    const productKey = productKeyMap[productId];
    
    if (priceData[productKey] && priceData[productKey][durationKey]) {
        return priceData[productKey][durationKey].numericPrice;
    }
    
    // Fallback to default price from subscriptions array
    const subscription = subscriptions.find(s => s.id === productId);
    return subscription ? subscription.price : 0;
}

// Dynamic Price Update based on Subscription Duration
function updatePrice(productId, duration) {
    const priceData = getPriceData();
    
    if (priceData[productId] && priceData[productId][duration]) {
        const prices = priceData[productId][duration];
        const container = document.querySelector('.price-section');
        
        if (container) {
            const currentPrice = container.querySelector('.current-price');
            const originalPrice = container.querySelector('.original-price');
            const discount = container.querySelector('.discount');
            
            if (currentPrice) currentPrice.textContent = prices.current;
            if (originalPrice) originalPrice.textContent = prices.original;
            if (discount) discount.textContent = prices.discount;
        }
    }
}

// Add event listeners to subscription options
function setupSubscriptionOptions() {
    const subscriptionOptions = document.querySelectorAll('.subscription-option input[type="radio"]');
    
    subscriptionOptions.forEach(option => {
        option.addEventListener('change', function() {
            if (this.checked) {
                const duration = this.value;
                const name = this.name;
                
                // Extract product ID from radio name (e.g., 'duration-chatgpt' -> 'chatgpt')
                const productId = name.replace('duration-', '');
                
                updatePrice(productId, duration);
            }
        });
    });
}
