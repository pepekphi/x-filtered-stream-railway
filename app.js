const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');

// Load environment variables
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Create a Twitter client
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

// Global variables for stream management
let streamInstance;
let isShuttingDown = false;

// Define inactivity timeout (30 minutes)
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in ms

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

// Function to send tweet data to the webhook
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
    console.error(
      `Error sending tweet ${tweet.id}:`,
      error.response ? error.response.data : error.message
    );
  }
}

// Function to initiate the stream connection with guard check, inactivity monitor, and error handling
async function startStream() {
  if (streamInstance) {
    console.log('Stream is already active.');
    return;
  }
  
  let inactivityTimer;

  // Function to reset inactivity timer
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log('No tweets received for 30 minutes. Restarting stream...');
      if (streamInstance && typeof streamInstance.destroy === 'function') {
        streamInstance.destroy();
      }
    }, INACTIVITY_TIMEOUT);
  };

  try {
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id,note_tweet,referenced_tweets',
      'user.fields': 'username',
      expansions: 'author_id,referenced_tweets.id'
    });
    console.log('Connected to Twitter stream.');
    
    // Start the inactivity timer
    resetInactivityTimer();
    
    for await (const { data, includes } of streamInstance) {
      const usernameForLog = (includes && includes.users && includes.users[0])
        ? includes.users[0].username
        : "unknown";
      console.log(`New tweet detected: ${data.id} from @${usernameForLog}`);
      resetInactivityTimer();  // Reset timer on each tweet
      await forwardTweet(data, includes);
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.log('Stream aborted.');
    } else {
      console.error('Stream error:', error);
    }
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (streamInstance && typeof streamInstance.destroy === 'function') {
      try {
        streamInstance.destroy();
      } catch (err) {
        console.error("Error destroying stream:", err);
      }
    }
    streamInstance = null;
  }
}

// Function to manage reconnections; runs until a shutdown is requested.
async function runStream() {
  while (!isShuttingDown) {
    await startStream();
    if (!isShuttingDown) {
      console.log('Stream disconnected. Reconnecting in 30 seconds...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
}

// Graceful shutdown: close the stream and exit.
function shutdown() {
  isShuttingDown = true;
  console.log('Shutdown initiated. Closing Twitter stream...');
  if (streamInstance && typeof streamInstance.destroy === 'function') {
    streamInstance.destroy();
  }
  process.exit(0);
}

// Listen for termination signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the stream management loop
runStream();
