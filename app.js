const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables from Railway
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Global variable to store the stream instance
let streamInstance;

// Function to send tweet data to Google Apps Script webhook
async function forwardTweet(tweet, includes) {
  // Extract the username using the expanded user details
  const user = includes.users.find(user => user.id === tweet.author_id);
  const username = user ? user.username : "Unknown";

  const payload = {
    timestamp: tweet.created_at,
    username: username,  // Use actual @username text
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: tweet.text,
  };

  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Tweet ${tweet.id} from @${username} forwarded.`);
  } catch (error) {
    console.error(`Error sending tweet ${tweet.id}:`, error.response ? error.response.data : error.message);
  }
}

// Function to start the Twitter stream
async function startStream() {
  try {
    // Start the stream with user expansions to get the text username
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id',
      'user.fields': 'username',
      expansions: 'author_id',
    });

    // Process each tweet as it comes in
    for await (const { data, includes } of streamInstance) {
      console.log(`New tweet detected: ${data.id} from @${includes.users[0].username}`);
      await forwardTweet(data, includes);
    }
  } catch (error) {
    // If error is due to shutdown (like AbortError), log accordingly.
    if (error.name === 'AbortError') {
      console.log('Stream aborted.');
    } else {
      console.error('Stream error:', error);
    }
  }
}

// Graceful shutdown logic: close the stream when the process is signaled to stop.
function shutdown() {
  console.log('Shutdown initiated. Closing Twitter stream...');
  if (streamInstance && typeof streamInstance.destroy === 'function') {
    streamInstance.destroy(); // Properly terminates the connection.
  }
  process.exit(0);
}

// Listen for termination signals (e.g., from Railway or local process manager)
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the stream listener
startStream();