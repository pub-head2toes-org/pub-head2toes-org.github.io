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
    const footerArea = document.getElementById('foot-container');

    // Set initial content
    sysMsg.textContent = "System ready";
    mainArea.innerHTML = "Welcome to the Retro Mainframe Terminal\n\nType 'help' for available commands\n";

    // Handle hypertext links
    mainArea.addEventListener('click', function(e) {
      const lineIndex = mainArea.value.substr(0, mainArea.selectionStart).split("\n").length-1;
      const lineText = mainArea.value.split("\n")[lineIndex];
      showLinks(lineText);
    });

  function getFiles (){
    const files = [];
    menuItems.forEach(item => {
      files.push(item[1]);
    });
    return files; 
  }

  function showLinks (lineText) {
    const links = getLinks(lineText);
    if (links.length > 0) {
      footerArea.innerHTML = `<a href="${links[0].linkURI}" target="blank">${links[0].linkText}</a>`;
    } else {
      footerArea.innerHTML = `${lineText.substr(0,20)}...`;
    }
  }

function getLinks(textLine) {
    // Regular expression to match Markdown links in the format [text](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const links = [];
    let match;

    while ((match = linkRegex.exec(textLine)) !== null) {
        const linkText = match[1].trim();
        const linkURI = match[2].trim();

        // Only add if both text and URI are non-empty
        if (linkText && linkURI) {
            links.push({
                linkText,
                linkURI
            });
        }
    }

    return links;
}

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

    let mdurl = "https://api.github.com/markdown/raw"
   	let hdrs = new Headers({"X-GitHub-Api-Version": "2022-11-28","Accept": "text/html"});
    let data = html 
    let fetchData = { 
      method: 'POST', 
      mode: 'cors',
      body: data,
      headers: hdrs
    }
    fetch(mdurl, fetchData).then(function(response) {
      response.text().then(function (text) {
        mainArea.innerHTML = text;
		    mainArea.scrollTop = 0;
        sysMsg.textContent = `Loaded: ${url}`;
        footerArea.innerHTML = ''
      });
    }).catch(function(error) {
      console.log('Looks like there was a problem: \n', error);
    }); 

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
