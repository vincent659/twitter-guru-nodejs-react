require('dotenv').config();
const express = require('express');
const AWS = require('aws-sdk');
const router = express.Router();
const Twit = require('twit');
const Analyzer = require('natural').SentimentAnalyzer;
const stemmer = require('natural').PorterStemmer;
const Sentiment = require('sentiment');
const keyword_extractor = require('keyword-extractor');
const redis = require('redis');

// Future: show the top 5 most popular words for this topic (excluding the keywords)

// Twitter API config
let T = new Twit({
  consumer_key: process.env.CONSUMER_KEY,
  consumer_secret: process.env.CONSUMER_SECRET,
  access_token: process.env.ACCESS_TOKEN,
  access_token_secret: process.env.ACCESS_TOKEN_SECRET,
  timeout_ms: 60 * 1000, // optional HTTP request timeout to apply to all requests.
  strictSSL: true, // optional - requires SSL certificates to be valid.
});

// create and connect redis client to local instance.
const redisClient = redis.createClient();
// Print redis errors to the console
redisClient.on('error', (err) => {
  console.log('Error ' + err);
});

// S3 unique bucket name
const bucketName = 'vincentchenn7588844-wikipedia-store';
// Storing object into s3
function s3Store(param, keyWord, mostRecentTime) {
  const s3Key = `tweets-${keyWord + mostRecentTime}`;

  // storing recieved tweets in s3
  const body = JSON.stringify({
    // source: 'S3 Bucket',
    ...param,
  });
  const objectParams = {
    Bucket: bucketName,
    Key: s3Key,
    Body: body,
  };
  const uploadPromise = new AWS.S3({ apiVersion: '2006-03-01' })
    .putObject(objectParams)
    .promise();
  uploadPromise.then(function (data) {
    console.log('Successfully uploaded data to ' + bucketName + '/' + s3Key);
  });
}

// Tweet Post Cleaning
function tweetClean(result) {
  let NoiseTwitterPosts = [];
  let temp = result.statuses;

  for (let i = 0; i < temp.length; i++) {
    let param = '';
    if (
      temp[i].text.slice(0, 3) == 'RT ' &&
      temp[i].text.includes('@') &&
      temp[i].text.includes('http')
    ) {
      param = temp[i].text.slice(3);
      NoiseTwitterPosts.push(param.replace(/(@\S+|(https)\S+)/gi, ''));
    } else if (
      temp[i].text.slice(0, 3) == 'RT ' &&
      temp[i].text.includes('http')
    ) {
      param = temp[i].text.slice(3);
      NoiseTwitterPosts.push(param.replace(/((http)\S+)/gi, ''));
    } else if (
      temp[i].text.slice(0, 3) == 'RT ' &&
      temp[i].text.includes('@')
    ) {
      param = temp[i].text.slice(3);
      NoiseTwitterPosts.push(param.replace(/(@\S+)/gi, ''));
    } else if (temp[i].text.includes('@') && temp[i].text.includes('http')) {
      NoiseTwitterPosts.push(temp[i].text.replace(/(@\S+|(https)\S+)/gi, ''));
    } else if (temp[i].text.slice(0, 3) == 'RT ') {
      NoiseTwitterPosts.push(temp[i].text.slice(3));
    } else if (temp[i].text.includes('@')) {
      NoiseTwitterPosts.push(temp[i].text.replace(/(@\S+)/gi, ''));
    } else if (temp[i].text.includes('http')) {
      NoiseTwitterPosts.push(temp[i].text.replace(/((http)\S+)/gi, ''));
    } else {
      NoiseTwitterPosts.push(temp[i].text);
    }
  }
  return NoiseTwitterPosts;
}

// sentiment analysis process
function sentimentAnalysis(NoiseTwitterPosts) {
  // Two different sources of sentiment anaylsis
  let sentiment = new Sentiment();
  let analyzer = new Analyzer('English', stemmer, 'senticon');
  let scores = [];
  let wordExtract = [];

  // Loop through tweets for sentiment analysis
  for (let i = 0; i < NoiseTwitterPosts.length; i++) {
    let extraction_result = keyword_extractor.extract(NoiseTwitterPosts[i], {
      language: 'english',
      remove_digits: true,
      return_changed_case: true,
      remove_duplicates: false,
    });

    // Averaging two sentiment scores from two sources for better accuracy
    let sentimentScore1 = analyzer.getSentiment(extraction_result);
    let SentimentScore2 = sentiment.analyze(NoiseTwitterPosts[i]);

    SentimentScoreAvg = (sentimentScore1 + SentimentScore2.comparative) / 2;

    // Check for NaN, if so assign as 0
    if (Number.isNaN(SentimentScoreAvg)) {
      SentimentScoreAvg = 0;
    }
    scores.push(SentimentScoreAvg);
    // wordExtract.push(extraction_result);
  }

  // Get the total average sentiment score
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    total = total + scores[i];
  }

  total = total / scores.length;

  return { scores, total /* wordExtract */ };
}

// Tweets Processing
router.post('/tweets', async (req, res) => {
  try {
    const keyWord = req.body.msg.trim();

    //<------ Getting Date Time START ------->
    let ts = Date.now();
    let date_ob = new Date(ts);
    let mostRecentTime = '';

    let date = date_ob.getDate();
    let month = date_ob.getMonth() + 1;
    let year = date_ob.getFullYear();
    if (date == 1 && month == 03) {
      mostRecentTime = year + '-' + month + '-' + 28;
    } else if (date == 1) {
      mostRecentTime = year + '-' + month + '-' + 30;
    } else {
      mostRecentTime = year + '-' + month + '-' + (date - 1);
    }
    //<------ Getting Date Time END ------->

    /* Redis Key */
    const redisKey = `tweets:${keyWord + mostRecentTime}`;
    /* S3 Key */
    const s3Key = `tweets-${keyWord + mostRecentTime}`;
    // Check S3
    const params = { Bucket: bucketName, Key: s3Key };

    return redisClient.get(redisKey, (err, result) => {
      // If data exists in Redis, Serve from Redis ELSE Check S3 for data
      if (result) {
        const resultJSON = JSON.parse(result);

        // Performing Tweet Text Clean Up
        let NoiseTwitterPosts = tweetClean(resultJSON);

        // Performing Sentiment Analysis
        let { scores, total /* wordExtract */ } = sentimentAnalysis(
          NoiseTwitterPosts
        );
        console.log(`${redisKey} was retrieved from Redis`);

        return res.status(200).json({
          source: 'Redis Cache',
          ...resultJSON,
          // wordExtract,
          scores,
          total,
        });
      } else {
        // Key does not exist in Redis than we check for s3
        return new AWS.S3({ apiVersion: '2006-03-01' }).getObject(
          params,
          (err, result) => {
            // If data exists in S3, Serve from S3 ELSE API Request
            if (result) {
              const resultJSON = JSON.parse(result.Body);

              // storing recieved tweets in redis
              redisClient.setex(
                redisKey,
                3600,
                JSON.stringify({ source: 'Redis Cache', ...resultJSON })
              );
              // Performing Tweet Text Clean Up
              NoiseTwitterPosts = tweetClean(resultJSON);

              // Performing Sentiment Analysis
              let { scores, total } = sentimentAnalysis(NoiseTwitterPosts);

              console.log(`${s3Key} was retrieved from S3`);

              return res.status(200).json({
                source: 'S3 Bucket',
                ...resultJSON,
                scores,
                total,
              });
            } else {
              T.get(
                'search/tweets',
                { q: `${keyWord} since:${mostRecentTime}`, count: 100 },
                function (err, data, response) {
                  const responseJSON = data;

                  // storing recieved tweets in s3
                  s3Store(responseJSON, keyWord, mostRecentTime);
                  // storing recieved tweets in redis
                  redisClient.setex(
                    redisKey,
                    3600,
                    JSON.stringify({
                      /* source: 'Redis Cache', */ ...responseJSON,
                    })
                  );

                  // Performing Tweet Text Clean Up
                  NoiseTwitterPosts = tweetClean(responseJSON);

                  // Performing Sentiment Analysis
                  let { scores, total } = sentimentAnalysis(NoiseTwitterPosts);

                  return res.status(200).json({
                    source: 'Twitter API',
                    ...responseJSON,
                    scores,
                    total,
                  });
                }
              );
              console.log(`${keyWord} was retrieved from Twitter API`);
            }
          }
        );
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
