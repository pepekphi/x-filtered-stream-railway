const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables from Railway
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Function to send tweet data to Google Apps Script webhook
async function forwardTweet(tweet, includes) {
  // Find the username based on author_id
  const user = includes.users.find(user => user.id === tweet.author_id);
  const username = user ? user.username : "Unknown"; // If user not found, fallback to "Unknown"

  const payload = {
    timestamp: tweet.created_at,
    username: username,  // Use actual @username
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: tweet.text,
  };

  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Tweet ${tweet.id} from @${username} forwarded to Google Apps Script.`);
  } catch (error) {
    console.error(`Error sending tweet ${tweet.id}:`, error.response ? error.response.data : error.message);
  }
}

// Connect to Twitter’s filtered stream and listen for new tweets
async function startStream() {
  try {
    const stream = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id',
      'user.fields': 'username',
      expansions: 'author_id',
    });

    for await (const { data, includes } of stream) {
      console.log(`New tweet detected: ${data.id} from @${includes.users[0].username}`);
      await forwardTweet(data, includes);
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

// Start the stream
startStream();