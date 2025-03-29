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
  let fullText = tweet.note_tweet && tweet.note_tweet.text ? tweet.note_tweet.text : tweet.text;

  // Replace t.co URLs in the main tweet text with display URLs if available
  // Only replace if the display_url does not contain an ellipsis ("…")
  if (tweet.entities && tweet.entities.urls) {
    tweet.entities.urls.forEach(urlEntity => {
      if (!urlEntity.display_url.includes("…")) {
        fullText = fullText.replace(urlEntity.url, urlEntity.display_url);
      }
    });
  }

  if (tweet.referenced_tweets && includes && includes.tweets) {
    tweet.referenced_tweets.forEach(refTweet => {
      let referencedTweet = includes.tweets.find(t => t.id === refTweet.id);
      if (referencedTweet) {
        let referencedFullText = referencedTweet.note_tweet && referencedTweet.note_tweet.text
          ? referencedTweet.note_tweet.text
          : referencedTweet.text;
        // Replace t.co URLs in referenced tweet text with display URLs if available
        if (referencedTweet.entities && referencedTweet.entities.urls) {
          referencedTweet.entities.urls.forEach(urlEntity => {
            if (!urlEntity.display_url.includes("…")) {
              referencedFullText = referencedFullText.replace(urlEntity.url, urlEntity.display_url);
            }
          });
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

  // If tweet.entities.urls exists and has at least one entry, select the expanded_url with the most characters.
  const tweetExpandedURL = tweet.entities && tweet.entities.urls && tweet.entities.urls.length > 0
    ? tweet.entities.urls.reduce((max, current) => {
        return current.expanded_url.length > max.expanded_url.length ? current : max;
      }, tweet.entities.urls[0]).expanded_url
    : "";

  const payload = {
    timestamp: tweet.created_at,
    username: username,
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: fullTweetText,
    tweetExpandedURL: tweetExpandedURL,
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

// Function to initiate the stream connection with a recurring inactivity check
async function startStream() {
  if (streamInstance) {
    console.log('Stream is already active.');
    return;
  }

  // Track the time of the last tweet received
  let lastTweetTime = Date.now();

  // Set up a recurring check for inactivity every minute
  const inactivityInterval = setInterval(() => {
    if (Date.now() - lastTweetTime >= INACTIVITY_TIMEOUT) {
      console.log(`No data received for ${INACTIVITY_TIMEOUT / 60000} minutes. Restarting stream...`);
      if (streamInstance && typeof streamInstance.destroy === 'function') {
        streamInstance.destroy();
      }
    }
  }, 60000); // check every minute

  try {
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id,note_tweet,referenced_tweets,entities',
      'user.fields': 'username',
      expansions: 'author_id,referenced_tweets.id'
    });

    console.log('Connected to Twitter stream.');
    lastTweetTime = Date.now(); // update on connect

    for await (const { data, includes } of streamInstance) {
      lastTweetTime = Date.now(); // update on each tweet
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
    clearInterval(inactivityInterval);
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
