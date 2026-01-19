document.addEventListener('DOMContentLoaded', function() {
    // Initialize menu
    const menuContainer = document.getElementById('menu-container');
    //const menuItems = require('./menu.js').default || require('./menu.js');

    // Create menu items
    menuItems.forEach(item => {
        const menuItem = document.createElement('a');
        menuItem.href = item[1];
        menuItem.textContent = `[ ${item[0].toUpperCase()} ]`;
        menuItem.className = 'menu-item';
        menuItem.addEventListener('click', function(e) {
            e.preventDefault();
            loadPage(item[1]);
        });
        menuContainer.appendChild(menuItem);
    });

    // Initialize terminal areas
    const cmdLine = document.getElementById('cmd_line_area');
    const sysMsg = document.getElementById('sys_msg');
    const mainArea = document.getElementById('main_area');

    // Set initial content
    cmdLine.value = "CMD> ";
    sysMsg.textContent = "System ready";
    mainArea.value = "Welcome to the Retro Mainframe Terminal\n\nType 'help' for available commands\n";

    // Handle key presses in command line
    cmdLine.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const command = cmdLine.value.trim().toLowerCase();

            // Simple command handling
            if (command === 'help') {
                sysMsg.textContent = "Available commands: [home], [shorts], [pwa], [almanac]";
            } else if (command === 'clear') {
                mainArea.value = "";
                sysMsg.textContent = "Screen cleared";
            } else if (command.startsWith('load ')) {
                const page = command.substring(5).trim();
                loadPage(page);
            } else {
                sysMsg.textContent = `Unknown command: ${command}`;
            }

            // Reset command line
            cmdLine.value = "CMD> ";
            setTimeout(() => cmdLine.focus(), 100);
        } else if (e.key === 'Backspace') {
            // Handle backspace for the cursor position
            const cursorPos = cmdLine.selectionStart;
            cmdLine.value = cmdLine.value.substring(0, cursorPos - 1) +
                          cmdLine.value.substring(cursorPos);
            cmdLine.selectionStart = cursorPos - 1;
            cmdLine.selectionEnd = cursorPos - 1;
        }
    });

    // Load page content
    function loadPage(url) {
        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.text();
            })
            .then(html => {
                // Simple HTML sanitization to prevent XSS
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const content = doc.body.innerText.replace(/\n/g, '\n\n');

                mainArea.value = content;
                sysMsg.textContent = `Loaded: ${url}`;
            })
            .catch(error => {
                sysMsg.textContent = `Error loading ${url}: ${error.message}`;
                console.error('Error:', error);
            });
    }

    // Handle window resize
    window.addEventListener('resize', function() {
        // Adjust terminal height on resize
        const terminal = document.querySelector('.terminal');
        const menuHeight = terminal.querySelector('.menu-bar').offsetHeight;
        const contentHeight = window.innerHeight * 0.8 - menuHeight - 20;
        terminal.style.height = `${contentHeight}px`;
    });

    // Initialize on load
    window.addEventListener('load', function() {
        // Set initial terminal height
        const terminal = document.querySelector('.terminal');
        const menuHeight = terminal.querySelector('.menu-bar').offsetHeight;
        terminal.style.height = `${window.innerHeight * 0.8 - menuHeight - 20}px`;

        // Focus command line
        setTimeout(() => cmdLine.focus(), 100);
    });
});
