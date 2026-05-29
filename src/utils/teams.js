const TEAMS_WEBHOOK_URL = import.meta.env.VITE_TEAMS_WEBHOOK_URL || '';

export const sendTeamsNotification = async (title, details, imageUrls = []) => {
if (!TEAMS_WEBHOOK_URL) return;
  try {
    const facts = Object.entries(details).map(([title, value]) => ({ title, value }));

    const card = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              {
                type: "TextBlock",
                text: title,
                weight: "Bolder",
                size: "Medium",
                color: "Accent"
              },
              {
                type: "FactSet",
                facts: facts
              }
            ]
          }
        }
      ]
    };

    const images = Array.isArray(imageUrls) ? imageUrls : (imageUrls ? [imageUrls] : []);

    if (images.length > 0) {
      if (images.length === 1) {
        card.attachments[0].content.body.push({
          type: "Image",
          url: images[0],
          size: "Auto",
          selectAction: {
            type: "Action.OpenUrl",
            url: images[0]
          }
        });
      } else {
        card.attachments[0].content.body.push({
          type: "ImageSet",
          imageSize: "Medium",
          images: images.map(url => ({
            type: "Image",
            url,
            selectAction: {
              type: "Action.OpenUrl",
              url: url
            }
          }))
        });
      }

      card.attachments[0].content.body.push({
        type: "ActionSet",
        actions: images.map((url, index) => ({
          type: "Action.OpenUrl",
          title: `🔍 ดูรูปใหญ่ ${images.length > 1 ? `(${index + 1})` : ""}`,
          url: url
        }))
      });
    }

    const response = await fetch(TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      console.error("Failed to send Teams notification:", response.statusText);
    }
  } catch (error) {
    console.error("Error sending Teams notification:", error);
  }
};
