document.addEventListener('DOMContentLoaded', function() {
  const mdConverter = new showdown.Converter();
  // Initialize menu
  const menuContainer = document.getElementById('menu-container');
  const hash = window.location.hash.substr(1);

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
  mainArea.innerHTML = "Welcome to the Retro Mainframe Terminal";

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

/**
 * Converts a Markdown document to an HTML document.
 * (gemma3:12b - nice attempt but not complete)
 * This is the way: Open source solution "showdown"
 * ref: https://github.com/showdownjs/showdown?tab=readme-ov-file
 *
 * @param {string} markdownText The Markdown text to convert.
 * @returns {string} The HTML document generated from the Markdown text.
 */
function markdownToHtml(markdownText) {
  if (!markdownText) {
    return '';
  }

  const lines = markdownText.split('\n');
  let html = '';
  let inList = false;
  let listType = ''; // 'ul' or 'ol'

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('## ')) {
      html += `<h2>${trimmedLine.substring(2)}</h2>`;
    } else if (trimmedLine.startsWith('# ')) {
      html += `<h1>${trimmedLine.substring(2)}</h1>`;
    } else if (trimmedLine.startsWith('### ')) {
      html += `<h3>${trimmedLine.substring(3)}</h3>`;
    } else if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('1. ')) {
      if (!inList) {
        if (trimmedLine.startsWith('1. ')) {
          listType = 'ol';
          html += '<ol>';
          inList = true;
        } else {
          listType = 'ul';
          html += '<ul>';
          inList = true;
        }
      }

      const listItemContent = trimmedLine.substring(2) || trimmedLine.substring(3);
      html += `<li>${listItemContent}</li>`;
    } else if (trimmedLine.startsWith('</li>')) {
      // This handles closing list items that might be malformed in input.
    }
    else if (inList) {
      if (listType === 'ol') {
        html += '</ol>';
      } else {
        html += '</ul>';
      }
      inList = false;
      listType = '';
    } else if (trimmedLine !== '') {
      html += `<p>${trimmedLine}</p>`;
    }
  }

  // Handle closing list if still open at the end.
  if (inList) {
    if (listType === 'ol') {
      html += '</ol>';
    } else {
      html += '</ul>';
    }
  }

  return html;
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

            mainArea.innerHTML = mdConverter.makeHtml(html);//markdownToHtml(html);
            mainArea.scrollTop = 0;
            sysMsg.textContent = `Loaded: ${url}`;
 

/*
        // This was the github markdown service
        // This is the way: Good enough but better to have a local lib for converting md to html
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
*/

      })
      .catch(error => {
          sysMsg.textContent = `Error loading ${url}: ${error.message}`;
          console.error('Error:', error);
      });
  }

  // Handle window resize
  window.addEventListener('resize', function() {
  });

  // Initialize on load
  window.addEventListener('load', function() {
      // Set initial terminal height
    if (hash){
      loadPage(hash);
    }
  });

  window.addEventListener('popstate', () => {
    const newhash = window.location.hash.substr(1);
    if (newhash){
      loadPage(newhash);
    }
  });
});
