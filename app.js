const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables from Railway (these will be set later)
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Function to send tweet data to Google Apps Script webhook
async function forwardTweet(tweet) {
  const payload = {
    timestamp: tweet.created_at,
    username: tweet.author_id, // This is the user ID; to fetch the actual name, you'd need user lookup
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: tweet.text,
  };

  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Tweet ${tweet.id} forwarded to Google Apps Script.`);
  } catch (error) {
    console.error(`Error sending tweet ${tweet.id}:`, error.response ? error.response.data : error.message);
  }
}

// Connect to Twitter’s filtered stream and listen for new tweets
async function startStream() {
  try {
    const stream = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id',
      expansions: 'author_id',
    });

    for await (const { data } of stream) {
      console.log(`New tweet detected: ${data.id}`);
      await forwardTweet(data);
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

// Start the stream
startStream();
