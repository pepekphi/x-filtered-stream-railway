const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables from Railway
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Global variable to store the stream instance
let streamInstance;

// Function to build the full tweet text using note_tweet and referenced tweets
function getFullTweetText(tweet, includes) {
  // Use note_tweet if available, else tweet.text
  let fullText = tweet.note_tweet && tweet.note_tweet.text ? tweet.note_tweet.text : tweet.text;

  // Process referenced tweets (quoted or retweeted) if they exist
  if (tweet.referenced_tweets && includes && includes.tweets) {
    tweet.referenced_tweets.forEach(refTweet => {
      let referencedTweet = includes.tweets.find(t => t.id === refTweet.id);
      if (referencedTweet) {
        // Use note_tweet for referenced tweets if available
        let referencedFullText = referencedTweet.note_tweet && referencedTweet.note_tweet.text
          ? referencedTweet.note_tweet.text
          : referencedTweet.text;
        // Remove newline characters
        referencedFullText = referencedFullText.replace(/\n/g, " ");
        if (refTweet.type === "quoted") {
          // Append quoted tweet text with quoted username information
          let quotedUser = includes.users.find(u => u.id === referencedTweet.author_id);
          let quotedUsername = quotedUser ? quotedUser.username : "unknown";
          fullText += ` [quoted tweet by @${quotedUsername}]${referencedFullText}[/quoted tweet]`;
        } else if (refTweet.type === "retweeted") {
          // For retweets, replace the full text
          let retweetedUser = includes.users.find(u => u.id === referencedTweet.author_id);
          let retweetedUsername = retweetedUser ? retweetedUser.username : "unknown";
          fullText = `RT @${retweetedUsername} ${referencedFullText}`;
        }
      }
    });
  }
  return fullText;
}

// Function to send tweet data to Google Apps Script webhook
async function forwardTweet(tweet, includes) {
  // Get the actual username from expanded user details
  const user = includes.users.find(user => user.id === tweet.author_id);
  const username = user ? user.username : "unknown";

  // Build the full tweet text using our logic
  const fullTweetText = getFullTweetText(tweet, includes);

  const payload = {
    timestamp: tweet.created_at,
    username: username,
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: fullTweetText,
  };

  try {
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Tweet ${tweet.id} from @${username} forwarded.`);
  } catch (error) {
    console.error(`Error sending tweet ${tweet.id}:`, error.response ? error.response.data : error.message);
  }
}

// Connect to Twitter’s filtered stream and listen for new tweets
async function startStream() {
  try {
    // Start the stream with additional tweet fields and expansions for referenced tweets
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id,note_tweet,referenced_tweets',
      'user.fields': 'username',
      expansions: 'author_id,referenced_tweets.id'
    });

    for await (const { data, includes } of streamInstance) {
      let usernameForLog = (includes && includes.users && includes.users[0]) ? includes.users[0].username : "unknown";
      console.log(`New tweet detected: ${data.id} from @${usernameForLog}`);
      await forwardTweet(data, includes);
    }
  } catch (error) {
    // If the error is due to an abort (shutdown), log it accordingly.
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

// Listen for termination signals (Railway or local process manager)
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the stream listener
startStream();