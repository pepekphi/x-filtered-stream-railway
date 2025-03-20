const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Environment variables (set these in Railway)
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client using the Bearer Token
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Global stream variable to allow closing it on shutdown.
let activeStream = null;

// Global map to group tweets by conversation ID
const groups = new Map();

async function processGroup(conversationId, group) {
  groups.delete(conversationId);
  group.tweets.sort((a, b) => BigInt(a.id) - BigInt(b.id));

  if (group.tweets.length === 1 && group.tweets[0].text.trim().startsWith('@')) {
    console.log(`Ignoring standalone reply tweet in conversation ${conversationId}`);
    return;
  }

  const combinedText = group.tweets.map(tweet => tweet.text.trim()).join(' ');
  const earliestTweet = group.tweets[0];

  const payload = {
    timestamp: earliestTweet.created_at,
    username: earliestTweet.username,
    tweetId: conversationId,
    conversationId: conversationId,
    tweetText: combinedText,
  };

  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Processed conversation ${conversationId} with ${group.tweets.length} tweet(s).`);
  } catch (error) {
    console.error(
      `Error sending grouped conversation ${conversationId}:`,
      error.response ? error.response.data : error.message
    );
  }
}

async function startStream() {
  try {
    activeStream = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id',
      'user.fields': 'username',
      expansions: 'author_id',
    });

    for await (const { data, includes } of activeStream) {
      const user = includes.users.find(u => u.id === data.author_id);
      const username = user ? user.username : "Unknown";

      const tweet = {
        id: data.id,
        conversation_id: data.conversation_id,
        created_at: data.created_at,
        text: data.text,
        username: username,
      };

      if (groups.has(tweet.conversation_id)) {
        groups.get(tweet.conversation_id).tweets.push(tweet);
      } else {
        const timer = setTimeout(() => {
          const group = groups.get(tweet.conversation_id);
          if (group) {
            processGroup(tweet.conversation_id, group);
          }
        }, 2000);
        groups.set(tweet.conversation_id, { tweets: [tweet], timer });
      }
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

// Graceful shutdown handling
function shutdown() {
  console.log('Shutdown initiated.');
  if (activeStream && typeof activeStream.close === 'function') {
    activeStream.close();
    console.log('Streaming connection closed.');
  }
  process.exit();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startStream();