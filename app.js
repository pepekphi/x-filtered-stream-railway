const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Environment variables (set these in Railway)
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client using the Bearer Token
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Global map to group tweets by conversation ID
const groups = new Map();

/**
 * Process a group of tweets (thread) after a 2 second waiting period.
 * The tweets are sorted by tweet ID, and their texts concatenated.
 * If there is only one tweet and it starts with '@', the group is ignored.
 *
 * @param {string} conversationId - The conversation (thread) ID.
 * @param {object} group - An object containing the tweets array.
 */
async function processGroup(conversationId, group) {
  // Remove the group from the map so it isn’t processed twice.
  groups.delete(conversationId);

  // Sort tweets by tweet ID (lowest to highest). Using BigInt for large IDs.
  group.tweets.sort((a, b) => BigInt(a.id) - BigInt(b.id));

  // If the group has only one tweet and its text starts with '@', ignore it.
  if (group.tweets.length === 1 && group.tweets[0].text.trim().startsWith('@')) {
    console.log(`Ignoring standalone reply tweet in conversation ${conversationId}`);
    return;
  }

  // Combine the tweet texts, separated by a space.
  const combinedText = group.tweets.map(tweet => tweet.text.trim()).join(' ');

  // Use the earliest tweet’s timestamp and username (assuming the thread is from one user)
  const earliestTweet = group.tweets[0];

  // Build payload with conversation ID as tweetId per your requirement.
  const payload = {
    timestamp: earliestTweet.created_at,
    username: earliestTweet.username,
    tweetId: conversationId, // Column D will show the conversation ID
    conversationId: conversationId, // Not used in the sheet for now
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

/**
 * Connect to Twitter's filtered stream and group tweets by conversation.
 */
async function startStream() {
  try {
    const stream = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id',
      'user.fields': 'username',
      expansions: 'author_id',
    });

    for await (const { data, includes } of stream) {
      // Get the full user info (username) from the expansions
      const user = includes.users.find(u => u.id === data.author_id);
      const username = user ? user.username : "Unknown";

      // Build tweet object with necessary fields.
      const tweet = {
        id: data.id,
        conversation_id: data.conversation_id,
        created_at: data.created_at,
        text: data.text,
        username: username,
      };

      // Group tweets by conversation ID.
      if (groups.has(tweet.conversation_id)) {
        groups.get(tweet.conversation_id).tweets.push(tweet);
      } else {
        // For a new conversation, create a group and set a 2-second timer.
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

// Start listening to the stream.
startStream();