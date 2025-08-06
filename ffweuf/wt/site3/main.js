try {
  document.addEventListener("DOMContentLoaded", async function () {
    const p = document.getElementById("authkey-chat-widget");

    if (p) {
      const originalText = "Hello, world!";
      const encodedText = encodeURIComponent(originalText);
      const ch = p.getAttribute("widget-id");

      window.WIDGET_ID = ch;
      window.WEBSITE_URL = window.location.origin;

      const d = await fetch(
        `https://napi.authkey.io/api/whatsapp_widget?method=retrieve_wg_token&wig_token=${ch}`
      );
      const nd = await d.json();
      const ndn = nd.success === true ? nd.data[0] : null;
      const pe2 = document.getElementById(ch);
      
      function ft() {
        const now = new Date();
        let hrs = now.getHours();
        const mnt = now.getMinutes();
        const ampm = hrs >= 12 ? "PM" : "AM";
        hrs = hrs % 12;
        hrs = hrs ? hrs : 12;
        const mf = mnt.toString().padStart(2, "0");
        const tf = `${hrs}:${mf} ${ampm}`;
        return tf;
      }

      class SocketIOAnalyticsTracker {
        constructor() {
          this.userId = this.generatePersistentUserId();
          this.sessionId = this.generateSessionId();
          this.serverUrl = 'http://localhost:3001';
          this.socket = null;
          this.isConnected = false;
          
          this.sessionStartTime = Date.now();
          this.lastActivityTime = Date.now();
          this.pageViewStartTime = Date.now();
          this.scrollDepth = 0;
          this.previousPage = document.referrer || 'direct';
          
          this.setupEventListeners();
        }

        generatePersistentUserId() {
          let userId = localStorage.getItem('analytics_user_id');
          if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('analytics_user_id', userId);
          }
          return userId;
        }

        generateSessionId() {
          return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        }

        setupEventListeners() {
          // Track scroll depth (keep for analytics)
          window.addEventListener('scroll', this.throttle(() => {
            const scrollPercent = Math.round(
              (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100
            );
            this.scrollDepth = Math.max(this.scrollDepth, scrollPercent || 0);
            this.updateActivity();
          }, 1000));

          // Track page unload (keep for page_exit tracking)
          window.addEventListener('beforeunload', () => {
            this.sendPageView('page_exit');
          });

          // Track mouse movement for activity detection (keep for user activity)
          let mouseTimer;
          document.addEventListener('mousemove', () => {
            clearTimeout(mouseTimer);
            mouseTimer = setTimeout(() => this.updateActivity(), 1000);
          });
        }

        throttle(func, delay) {
          let timeoutId;
          let lastExecTime = 0;
          return function (...args) {
            const currentTime = Date.now();
            if (currentTime - lastExecTime > delay) {
              func.apply(this, args);
              lastExecTime = currentTime;
            } else {
              clearTimeout(timeoutId);
              timeoutId = setTimeout(() => {
                func.apply(this, args);
                lastExecTime = Date.now();
              }, delay - (currentTime - lastExecTime));
            }
          };
        }

        updateActivity() {
          this.lastActivityTime = Date.now();
        }


        initialize() {
          this.socket = io(this.serverUrl, {
            transports: ['websocket', 'polling'],
            upgrade: true,
            rememberUpgrade: true
          });
          
          this.socket.on('connect', () => {
            this.isConnected = true;
            this.requestLocation();
            this.sendPageView('page_enter');
          });
          
          this.socket.on('live_users_count', (data) => {
          });
          
          this.socket.on('disconnect', () => {
            this.isConnected = false;
          });

          this.socket.on('connect_error', (error) => {
            console.error('❌ [ANALYTICS] Socket.IO error:', error);
          });
        }

        getDeviceInfo() {
          return {
            screenWidth: screen.width,
            screenHeight: screen.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            colorDepth: screen.colorDepth,
            pixelRatio: window.devicePixelRatio,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            language: navigator.language,
            platform: navigator.platform,
            cookieEnabled: navigator.cookieEnabled,
            onlineStatus: navigator.onLine
          };
        }

        getBrowserInfo() {
          const ua = navigator.userAgent;
          let browser = 'unknown';
          if (ua.includes('Chrome')) browser = 'Chrome';
          else if (ua.includes('Firefox')) browser = 'Firefox';
          else if (ua.includes('Safari')) browser = 'Safari';
          else if (ua.includes('Edge')) browser = 'Edge';
          
          return {
            userAgent: ua,
            browser: browser,
            vendor: navigator.vendor
          };
        }

        sendPageView(eventType = 'page_view') {
          const now = Date.now();
          const timeOnPage = now - this.pageViewStartTime;

          const message = {
              type: 'analytics_event',
              eventType: eventType,
              userId: this.userId,
              sessionId: this.sessionId,
              timestamp: now,
              websiteUrl: window.WEBSITE_URL || window.location.origin,
              widgetId: window.WIDGET_ID,

            // Page info
            url: window.location.href,
            path: window.location.pathname,
            title: document.title,
            referrer: this.previousPage,

            // Session info
            sessionDuration: now - this.sessionStartTime,
            timeOnPage: timeOnPage,

            // Engagement metrics
            scrollDepth: this.scrollDepth,

            // Device & browser info
            device: this.getDeviceInfo(),
            browser: this.getBrowserInfo(),

            // Location data (use stored location if available)
            location: this.currentLocation || null,

            // Additional context
            widgetId: ch,
            isActive: !document.hidden,
            timeSinceLastActivity: now - this.lastActivityTime
          };
          
          this.sendMessage(message);
          
          // Reset page-specific counters for new page view
          if (eventType === 'page_enter') {
            this.pageViewStartTime = now;
            this.scrollDepth = 0;
          }
        }

        sendEvent(eventType, eventData = {}) {
          const message = {
            type: 'analytics_event',
            eventType: eventType,
            userId: this.userId,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            url: window.location.href,
            websiteUrl: window.WEBSITE_URL || window.location.origin,
            widgetId: window.WIDGET_ID,
            eventData: eventData
          };
          
          this.sendMessage(message);
        }

        // sendHeartbeat function removed - data is now transmitted via WebSocket events only

        sendMessage(message) {
          if (this.socket && this.socket.connected) {
            this.socket.emit(message.type, message);
          } else {
            console.warn('❌ [ANALYTICS] Socket.IO not ready, message queued');
          }
        }

        requestLocation() {
          if (!navigator.geolocation) {
            console.warn('❌ [ANALYTICS] Geolocation not supported');
            return;
          }

          navigator.geolocation.getCurrentPosition(
            (position) => {
              const locationData = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                altitude: position.coords.altitude,
                speed: position.coords.speed,
                timestamp: Date.now()
              };

              this.currentLocation = locationData;
              
              // Immediately send location data to server
              this.sendMessage({
                type: 'analytics_event',
                eventType: 'location_update',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: Date.now(),
                location: locationData,
                url: window.location.href,
                websiteUrl: window.WEBSITE_URL || window.location.origin,
                widgetId: window.WIDGET_ID,
                device: this.getDeviceInfo(),
                browser: this.getBrowserInfo()
              });
            },
            (error) => {
              console.warn('❌ [ANALYTICS] Location error:', error.message);
              this.sendMessage({
                type: 'analytics_event',
                eventType: 'location_error',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: Date.now(),
                error: error.message,
                url: window.location.href,
                websiteUrl: window.WEBSITE_URL || window.location.origin,
                widgetId: window.WIDGET_ID
              });
            },
            {
              enableHighAccuracy: true,
              timeout: 15000,
              maximumAge: 300000 // 5 minutes
            }
          );
        }

        cleanup() {
          this.sendPageView('page_exit');
          if (this.socket && this.socket.connected) {
            this.socket.disconnect();
          }
        }
      }

      // Your existing HTML/CSS code (unchanged)
      var nwc = `
        <style>
          .authkey-dh{
            display:none;
            opacity:0;
            marigin-bottom:0;
          }
          .authkey-ds{
            display:block;
            opactiy:1;
            margin-bottom:20px;
          }
          .authkey-whatsappBtn {
            border-radius: 100%;
            line-height: 1.32;
            color: rgb(255, 255, 255);
            font-size: 0px;
            background-color: #25d366;
            border-width: 0px;
            padding: 0px;
            height: fit-content;
            width: fit-content;
            cursor: pointer;
            position: relative;
            float:${ndn.wig_position};
          }
          .authkey-whatsappIcon{
            fill: white;
            width: 3.125rem;
            height: 3.125rem;
            padding: 0.4375rem;
          }
          .authkey-whatsappLive {
            background-color: rgb(255, 0, 0);
            position: absolute;
            z-index: 1;
            border-radius: 50%;
            display: block !important;
            height: .6rem;
            width: .6rem;
            font-size: .687rem;
            top: 7px;
            right: 2px;
          }
          .authkey-whatsappHeader {
            color: rgb(17, 17, 17);
            display: flex;
            -webkit-box-align: center;
            align-items: center;
            padding: 18px;
            background: ${ndn.back_color};
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }
          .authkey-whatsappAvataarContainer {
            position: relative;
            width: 52px;
            height: 52px;
            box-shadow: rgba(17, 17, 17, 0.1) 0px 0px 2px inset;
            border-radius: 50%;
            display: block;
            flex-shrink: 0;
            overflow: inherit;
            cursor: pointer;
          }
          .authkey-whatsappAvataar {
            width: 52px;
            height: 52px;
            background-color: rgb(210, 210, 210);
            opacity: 1;
            border-radius: 50%;
            overflow: hidden;
            position: relative;
            z-index: 1;
          }
         
          .authkey-whatsappAvataarImg {
            object-fit: cover;
            display: inline-block !important;
            position: static !important;
            margin: 0px !important;
            padding: 0px !important;
            max-width: none !important;
            height: inherit !important;
            width: inherit !important;
            visibility: visible !important;
          }
          .authkey-whatsappAvataarContainer:before {
            content: "";
            bottom: 0px;
            right: 0px;
            width: 12px;
            height: 12px;
            box-sizing: border-box;
            position: absolute;
            z-index: 2;
            border-radius: 50%;
            background-color: rgb(74, 213, 4);
            display: block;
            border: 2px solid rgb(0, 128, 105);
          }
          .authkey-whatsappClientImg:before {
            content: "";
            bottom: 0px;
            right: 0px;
            width: 12px;
            height: 12px;
            box-sizing: border-box;
            position: absolute;
            z-index: 2;
            border-radius: 50%;
            background-color: rgb(74, 213, 4);
            display: block;
            border: 2px solid rgb(0, 128, 105);
          }
          .authkey-whatsappWindow {
            z-index: 2147483647;
            width: 300px;
            pointer-events: all;
            touch-action: auto;
            transition: opacity 0.3s, margin 0.3s, visibility 0.3s;
            inset: auto 20px 76px auto;
          }
          .authkey-whatsappWindowShadow {
            border-radius: 16px;
            overflow: hidden;
            position: relative;
            box-shadow: rgba(0, 0, 0, 0.3) 0px 4px 30px 0px;
          }
          .authkey-whatsappCloseIcon {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 20px;
            height: 20px;
            opacity: 0.4;
            cursor: pointer;
            transition: 0.3s;
            outline: transparent;
            -webkit-box-pack: center;
            justify-content: center;
            -webkit-box-align: center;
            align-items: center;
            display: flex !important;
          }
          .authkey-whatsappCloseIcon:before, .authkey-whatsappCloseIcon:after {
            content: "";
            position: absolute;
            width: 12px;
            height: 2px;
            background-color: rgb(255, 255, 255);
            display: block;
            border-radius: 2px;
          }
          .authkey-whatsappCloseIcon:before {
            transform: rotate(45deg);
          }
          .authkey-whatsappCloseIcon:after {
            transform: rotate(-45deg);
          }
          .authkey-whatsappHeaderInfo {
            margin-left: 16px;
            margin-right: 16px;
            width: 100%;
            overflow: hidden;
          }
          .authkey-whatsappAvataarName {
            font-size: 16px;
            font-weight: 700;
            line-height: 20px;
            max-height: 60px;
            -webkit-line-clamp: 3;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            overflow: hidden;
            color: rgb(255, 255, 255);
            font-family:Arial, Helvetica, sans-serif;
          }
          .authkey-whatsappOnline {
            font-size: 13px;
            line-height: 18px;
            margin-top: 4px;
            color: rgb(255, 255, 255);
            font-family:Arial, Helvetica, sans-serif;
          }
          .authkey-whatsappBottomLayout {
            background: url(https://static.elfsight.com/apps/all-in-one-chat/patterns/background-whatsapp.jpg) center center / cover no-repeat;
          }
          .authkey-whatsappChatbox {
            position: relative;
            padding: 20px 20px 12px;
            overflow: auto;
            max-height: 382px;
          }
          .authkey-whatsappChatLayout {
            padding: 6px 14px;
            position: relative;
            transform-origin: center top;
            z-index: 2;
            color: rgb(255, 255, 255);
            font-size: 15px;
            line-height: 1.39;
            max-width: calc(100% - 50px);
            border-radius: 0px 16px 16px;
            background-color: rgb(255, 255, 255);
            opacity: 1;
            hyphens: auto;
            box-shadow: rgba(0, 0, 0, 0.15) 0px 1px 0px 0px;
          }
          .authkey-whatsappChatMessage {
            display: flex;
            align-items: flex-end;
            color: #000;
            font-family:Arial, Helvetica, sans-serif;
          }
          .authkey-whatsappChatSvg {
            position: absolute;
            top: 0px;
            left: -9px;
          }
          .authkey-whatsappChatTime {
            text-align: right;
            margin-left: 12px;
            font-size: 12px;
            line-height: 14px;
            opacity: 0.5;
            color: #000;
            font-family:Arial, Helvetica, sans-serif;
          }
          .authkey-whatsappBtnInline {
            border-radius: 24px;
            border-color: rgba(255, 255, 255, 0.1);
            width: auto;
            line-height: 1.32;
            color: rgb(255, 255, 255);
            font-family: inherit;
            font-weight: bold;
            font-size: 16px;
            background-color: rgb(37, 211, 102);
            border-width: 0px;
            padding: 0px;
            margin: 20px;
            max-width: 100%;
            box-shadow: rgba(0, 0, 0, 0.25) 0px 1px 0px 0px;
            padding: 12px 27px;
            cursor:pointer;
          }
          .authkey-whatsappBottomnext {
            display: flex;
            -webkit-box-pack: center;
            justify-content: center;
          }
          .authkey-m-d {
            position: fixed;
            bottom: ${ndn.bottom_align}px;
            ${ndn.wig_position}: ${ndn.side_align}px;
            Z-index:10000;
          }
          .authkey-branding {
            display: flex;
            justify-content: center;
            align-items: center;
            background-color: #ffffff;
            margin: 0;
          }
          .authkey-branding p{
            font-size: 10px;
            margin-top: 4px;
            margin-bottom: 4px;
            margin-left: 1%;
            margin-right: 1%;
          }
          .authkey-branding img{
            width: 0.8em;
          }
          .authkey-branding a{
            font-size: 10px;
            text-decoration: none;
          }
        </style>
        <div class="authkey-m-d">
          <div id="authkey-tgl" class="authkey-whatsappWindow ">
            <div class="authkey-whatsappWindowShadow">
              <div role="button" id="authkey-cbtn" tabindex="0" class="authkey-whatsappCloseIcon"></div>
              <div class="authkey-whatsappHeader">
                <div class="authkey-whatsappAvataarContainer">
                  <div class="authkey-whatsappAvataar">
                    <img src=${ndn.image_url} alt="user_image" class="authkey-whatsappAvataarImg">
                  </div>
                </div>
                <div class="authkey-whatsappHeaderInfo">
                  <div class="authkey-whatsappAvataarName">${ndn.display_name}</div>
                  <div class="authkey-whatsappOnline">Online</div>
                </div>
              </div>
              <div class="authkey-whatsappBottomLayout">
                <div class="authkey-whatsappChatbox">
                  <div class="authkey-whatsappChatLayout">
                    <svg xmlns="http://www.w3.org/2000/svg" width="9" height="17" viewBox="0 0 9 17" fill="currentColor" class="authkey-whatsappChatSvg"><path d="M0.772965 3.01404C-0.0113096 1.68077 0.950002 0 2.49683 0H9V17L0.772965 3.01404Z" fill="currentColor"></path></svg>
                    <div class="authkey-whatsappChatMessage">
                      <div>${ndn.welcome_text}</div>
                    </div>
                    <div class="authkey-whatsappChatTime">
                      ${ft()}
                    </div>
                  </div>
                  <div style="display: flex-direction: column;  position: relative; background-color: transparent;">
                    <div style="display: flex; margin-top: 30px;  flex-direction: column; position: relative; background-color: transparent; overflow-x: hidden;">
                      <!-- Message Input -->
                      <textarea
                        id="message-input"
                        placeholder="Type your text here..."
                        style="width: 100%; height: 30px; padding: 12px; border: 1px solid #e1e1e1; font-size: 15px; background-color: #f7f7f7; resize: none; outline: none; color: #333; box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1); transition: all 0.3s ease; padding-right: 50px; border-radius: 15px;" 
                      ></textarea>

                      <!-- Send Button -->
                      <button
                        id="send-button"
                        style="background-color: #25d366; border: none; border-radius: 50%; width: 45px; height: 45px; display: flex; justify-content: center; align-items: center; cursor: pointer; position: absolute; right: 0; top: 50%; transform: translateY(-50%); transition: background-color 0.3s ease;"
                      >
                        <span
                          style="font-size: 20px; color: white;  font-weight: bold; line-height: 0;"
                        >➤</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div
                id="whatsapp-container"
                style="width: 100%; background-color: #ffffff; border-radius: 10px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 16px; display: flex; flex-direction: column; font-family: 'Roboto', sans-serif;"
              >
              </div>
              <div class="authkey-branding">
                <img
                  draggable="false"
                  alt="⚡"
                  src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzNiAzNiI+PHBhdGggZmlsbD0iI0ZGQUMzMyIgZD0iTTMyLjkzOCAxNS42NTFDMzIuNzkyIDE1LjI2IDMyLjQxOCAxNSAzMiAxNUgxOS45MjVMMjYuODkgMS40NThjLjIxOS0uNDI2LjEwNi0uOTQ3LS4yNzEtMS4yNDNDMjYuNDM3LjA3MSAyNi4yMTggMCAyNiAwYy0uMjMzIDAtLjQ2Ni4wODItLjY1My4yNDNMMTggNi41ODggMy4zNDcgMTkuMjQzYy0uMzE2LjI3My0uNDMuNzE0LS4yODQgMS4xMDVTMy41ODIgMjEgNCAyMWgxMi4wNzVMOS4xMSAzNC41NDJjLS4yMTkuNDI2LS4xMDYuOTQ3LjI3MSAxLjI0My4xODIuMTQ0LjQwMS4yMTUuNjE5LjIxNS4yMzMgMCAuNDY2LS4wODIuNjUzLS4yNDNMMTggMjkuNDEybDE0LjY1My0xMi42NTVjLjMxNy0uMjczLjQzLS43MTQuMjg1LTEuMTA2eiIvPjwvc3ZnPg=="
                />
                <p>by   </p>
                <a href="https://authkey.io" target="_blank" >
                  Authkey.io
                </a>
              </div>
            </div>
          </div>

          <button class="authkey-whatsappBtn" id="authkey-wt-btn">
            <svg viewBox="0 0 32 32" class="authkey-whatsappIcon"><path d=" M19.11 17.205c-.372 0-1.088 1.39-1.518 1.39a.63.63 0 0 1-.315-.1c-.802-.402-1.504-.817-2.163-1.447-.545-.516-1.146-1.29-1.46-1.963a.426.426 0 0 1-.073-.215c0-.33.99-.945.99-1.49 0-.143-.73-2.09-.832-2.335-.143-.372-.214-.487-.6-.487-.187 0-.36-.043-.53-.043-.302 0-.53.115-.746.315-.688.645-1.032 1.318-1.06 2.264v.114c-.015.99.472 1.977 1.017 2.78 1.23 1.82 2.506 3.41 4.554 4.34.616.287 2.035.888 2.722.888.817 0 2.15-.515 2.478-1.318.13-.33.244-.73.244-1.088 0-.058 0-.144-.03-.215-.1-.172-2.434-1.39-2.678-1.39zm-2.908 7.593c-1.747 0-3.48-.53-4.942-1.49L7.793 24.41l1.132-3.337a8.955 8.955 0 0 1-1.72-5.272c0-4.955 4.04-8.995 8.997-8.995S25.2 10.845 25.2 15.8c0 4.958-4.04 8.998-8.998 8.998zm0-19.798c-5.96 0-10.8 4.842-10.8 10.8 0 1.964.53 3.898 1.546 5.574L5 27.176l5.974-1.92a10.807 10.807 0 0 0 16.03-9.455c0-5.958-4.842-10.8-10.802-10.8z" fill-rule="evenodd"></path></svg>
            <span class="authkey-whatsappLive"></span>
          </button>
        </div>
      `;
      
      // Create widget container
      const cw = document.createElement("div");
      cw.id = "authkey-wp-widget-container";
      document.body.appendChild(cw);
      cw.innerHTML += nwc;

      // ✅ Initialize Enhanced Analytics
      window.analyticsTracker = new SocketIOAnalyticsTracker();
      window.analyticsTracker.initialize();

      // Enhanced send button handler
      function handleSendClick() {

        // Track the interaction
        window.analyticsTracker.sendEvent('whatsapp_send_click', {
          messageLength: document.getElementById('message-input')?.value?.length || 0
        });


        setTimeout(() => {
          const messageInput = document.getElementById('message-input');
          if (messageInput) messageInput.value = '';
          window.open(`https://wa.me/${ndn.mobile_no}`, "_blank");
        }, 1000);
      }

      // Your original event listeners with analytics enhancement
      const wtbtn = document.getElementById("authkey-wt-btn");
      const td = document.getElementById("authkey-tgl");
      const cbtn = document.getElementById("authkey-cbtn");
      const wprb = document.getElementById("authkey-wp-r-b");
      
      if (ndn.default_open === 1) {
        td.classList.add("authkey-dh");
        setTimeout(() => {
          td.classList.remove("authkey-dh");
          td.classList.add("authkey-ds");
        }, 3000);
      } else {
        td.classList.add("authkey-dh");
      }
      
      if (wprb) {
        wprb.addEventListener("click", () => {
          window.analyticsTracker.sendEvent('whatsapp_quick_click');
          const url = `https://wa.me/${ndn.mobile_no}`;
          window.open(url, "_blank");
        });
      }
      
      cbtn.addEventListener("click", () => {
        if (td.classList.contains("authkey-ds")) {
          td.classList.remove("authkey-ds");
          td.classList.add("authkey-dh");
          window.analyticsTracker.sendEvent('widget_close');
        }
      });
      
      wtbtn.addEventListener("click", () => {
        if (td.classList.contains("authkey-ds")) {
          td.classList.remove("authkey-ds");
          td.classList.add("authkey-dh");
          window.analyticsTracker.sendEvent('widget_minimize');
        } else {
          td.classList.remove("authkey-dh");
          td.classList.add("authkey-ds");
          window.analyticsTracker.sendEvent('widget_open');
        }
      });

      // Attach enhanced send button
      setTimeout(() => {
        const sendButton = document.getElementById('send-button');
        if (sendButton) {
          sendButton.addEventListener('click', handleSendClick);
        }
      }, 1000);

      window.addEventListener('beforeunload', () => {
        if (window.analyticsTracker) {
          window.analyticsTracker.cleanup();
        }
      });

    } else {
      console.log("Parent element not found");
    }
  });
} catch (error) {
  console.error('❌ [ANALYTICS] Main error:', error);
}
