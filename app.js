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

// Define inactivity timeout (set to 30 minutes)
const INACTIVITY_TIMEOUT = 1800000; // 30 minutes in ms

// Function to build the full tweet text using note_tweet and referenced tweets
function getFullTweetText(tweet, includes) {
  // Global flag to ensure a maximum of one non-picture link conversion is performed across main and referenced tweets.
  let conversionPerformed = false;
  let fullText = tweet.note_tweet && tweet.note_tweet.text ? tweet.note_tweet.text : tweet.text;

  // Process main tweet URLs:
  // For non-picture links, try converting candidates until one qualifies.
  if (tweet.entities && tweet.entities.urls) {
    for (const urlEntity of tweet.entities.urls) {
      if (!conversionPerformed && !(urlEntity.display_url.includes("pic.") || urlEntity.display_url.includes("pic.twitter.com"))) {
        if (urlEntity.expanded_url && urlEntity.expanded_url.length <= 170) {
          fullText = fullText.replace(urlEntity.url, urlEntity.expanded_url);
          conversionPerformed = true;
        }
      }
    }
  }

  // Process referenced tweets only if no conversion has been performed yet.
  if (tweet.referenced_tweets && includes && includes.tweets) {
    tweet.referenced_tweets.forEach(refTweet => {
      let referencedTweet = includes.tweets.find(t => t.id === refTweet.id);
      if (referencedTweet) {
        let referencedFullText = referencedTweet.note_tweet && referencedTweet.note_tweet.text
          ? referencedTweet.note_tweet.text
          : referencedTweet.text;
        // Try converting a non-picture link if one hasn't been converted already.
        if (!conversionPerformed && referencedTweet.entities && referencedTweet.entities.urls) {
          for (const urlEntity of referencedTweet.entities.urls) {
            if (!conversionPerformed && !(urlEntity.display_url.includes("pic.x.com"))) {
              if (urlEntity.expanded_url && urlEntity.expanded_url.length <= 170) {
                referencedFullText = referencedFullText.replace(urlEntity.url, urlEntity.expanded_url);
                conversionPerformed = true;
                break;
              }
            }
          }
        }
        referencedFullText = referencedFullText.replace(/\n/g, " ");
        if (refTweet.type === "quoted") {
          let quotedUser = includes.users.find(u => u.id === referencedTweet.author_id);
          let quotedUsername = quotedUser ? quotedUser.username : "unknown";
          fullText += ` [quoted tweet by @${quotedUsername}]${referencedFullText}[/quoted tweet]`;
        } else if (refTweet.type === "retweeted") {
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
  const user = includes.users.find(user => user.id === tweet.author_id);
  const username = user ? user.username : "unknown";

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

// Function to initiate the stream connection with guard check, inactivity monitoring, and error handling
async function startStream() {
  if (streamInstance) {
    console.log('Stream is already active.');
    return;
  }

  let inactivityTimer;

  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log(`No data received for ${INACTIVITY_TIMEOUT / 60000} minutes. Restarting stream...`);
      if (streamInstance && typeof streamInstance.destroy === 'function') {
        streamInstance.destroy();
      }
    }, INACTIVITY_TIMEOUT);
  };

  try {
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id,note_tweet,referenced_tweets,entities',
      'user.fields': 'username',
      expansions: 'author_id,referenced_tweets.id'
    });

    console.log('Connected to Twitter stream.');
    resetInactivityTimer();

    for await (const { data, includes } of streamInstance) {
      resetInactivityTimer();
      const usernameForLog = (includes && includes.users && includes.users[0])
        ? includes.users[0].username
        : "unknown";
      console.log(`New tweet detected: ${data.id} from @${usernameForLog}`);
      await forwardTweet(data, includes);
    }
  } catch (error) {
    if (error && error.code === 429) {
      console.error("Rate limit error encountered:", error);
      throw error;
    } else if (error && error.name === 'AbortError') {
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
  let reconnectDelay = 30000; // initial delay 30 seconds for non-rate-limit errors
  while (!isShuttingDown) {
    try {
      await startStream();
      reconnectDelay = 30000;
    } catch (error) {
      if (error && error.code === 429) {
        reconnectDelay = reconnectDelay < 60000 ? 60000 : reconnectDelay * 2;
        console.error(`Received 429 error. Backing off reconnection for ${reconnectDelay / 1000} seconds.`);
      }
    }
    if (!isShuttingDown) {
      console.log(`Stream disconnected. Reconnecting in ${reconnectDelay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, reconnectDelay));
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

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

runStream();
