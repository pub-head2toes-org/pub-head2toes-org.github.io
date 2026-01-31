class OllamaAPI {
  async sendMessage(model, endpoint, context, messages) {
    try {
      const payload = {
        model: model,
        stream: false,
        options: {
          num_ctx: context
        },
        messages: messages
      };

      const start = Date.now();
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });
      const end = Date.now();
      const time = (end - start)/1000;

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const data = await response.json();
      return { content: data.message.content, time: time };
    } catch (error) {
      const t = (Date.now() - start)/1000;
      console.error('Error calling Ollama API:[${t}]', error);
      throw error;
    }
  }

async availableModels(baseURL) {
  try {
    const response = await fetch(`${baseURL}/api/tags`);
    const data = await response.json();

    if (response.ok && data && data.models && Array.isArray(data.models)) {
      const modelNames = data.models.map(model => model.name);
      return modelNames;
    } else {
      console.error('Failed to fetch or parse models:', data, response);
      return [];
    }
  } catch (error) {
    console.error('Error fetching models:', error);
    return ['err'];
  }
}
}

const ollamaAPI = new OllamaAPI();
window.ollamaAPI = ollamaAPI;
