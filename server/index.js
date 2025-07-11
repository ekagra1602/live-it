const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();
// Google Gen AI SDK (New SDK with Veo 2 support)
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Generate video endpoint - now handles both text and image
app.post('/api/generate-video', upload.single('image'), async (req, res) => {
  // Set a longer timeout for this route
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  
  try {
    const { prompt } = req.body;
    const imageFile = req.file;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log('🎬 Generating video with Veo 2...');

    // Prepare the generation config
    const config = {
      personGeneration: "dont_allow",
      aspectRatio: "16:9",
    };

    let operation;

    console.log('🎬 Starting Veo 2 video generation...');
    
    if (imageFile) {
      // Image-to-video generation
      console.log('📷 Processing image:', {
        filename: imageFile.originalname,
        size: imageFile.size,
        mimetype: imageFile.mimetype
      });
      
      // Check image size (Veo 2 might have limits)
      if (imageFile.size > 10 * 1024 * 1024) { // 10MB limit
        fs.unlinkSync(imageFile.path);
        return res.status(400).json({
          error: 'Image too large',
          message: 'Please use an image smaller than 10MB'
        });
      }
      
      const imageBuffer = fs.readFileSync(imageFile.path);
      const imageBase64 = imageBuffer.toString('base64');
      
      console.log('📷 Image converted to base64, length:', imageBase64.length);
      
      operation = await ai.models.generateVideos({
        model: "veo-2.0-generate-001",
        prompt: prompt,
        image: {
          imageBytes: imageBase64,
          mimeType: imageFile.mimetype,
        },
        config: {
          personGeneration: "dont_allow",
          aspectRatio: "16:9",
        },
      });
      
      fs.unlinkSync(imageFile.path); // Clean up
    } else {
      // Text-to-video generation
      operation = await ai.models.generateVideos({
        model: "veo-2.0-generate-001", 
        prompt: prompt,
        config: {
          personGeneration: "dont_allow",
          aspectRatio: "16:9",
        },
      });
    }

    // Poll for completion
    let pollCount = 0;
    const maxPolls = 20; // Max 200 seconds (20 * 10 seconds)
    
    while (!operation.done && pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      operation = await ai.operations.getVideosOperation({ operation });
      pollCount++;
      
      console.log(`Polling attempt ${pollCount}, status: ${operation.done ? 'done' : 'pending'}`);
    }
    
    if (!operation.done) {
      return res.status(408).json({
        error: 'Video generation timeout',
        message: 'Generation took longer than expected'
      });
    }

    // Debug: log the full response structure
    console.log('✅ Operation completed!');
    console.log('Response structure:', JSON.stringify(operation.response, null, 2));
    
    // Get the video URL - try different possible response structures
    let videoUri = null;
    
    if (operation.response?.generatedVideos?.[0]?.video?.uri) {
      videoUri = operation.response.generatedVideos[0].video.uri;
    } else if (operation.response?.generated_videos?.[0]?.video?.uri) {
      videoUri = operation.response.generated_videos[0].video.uri;
    } else if (operation.response?.videos?.[0]?.uri) {
      videoUri = operation.response.videos[0].uri;
    } else if (operation.response?.video?.uri) {
      videoUri = operation.response.video.uri;
    }
    
    if (videoUri) {
      console.log('🎥 Video URI found:', videoUri);
      const fullVideoUrl = `${videoUri}&key=${process.env.GEMINI_API_KEY}`;
      
      // Send video to Gradio server for 3D conversion
      console.log('🔄 Sending video to Gradio server for 3D conversion...');
      
      try {
        const gradioResponse = await fetch('https://e887ddc6057cfd219d.gradio.live/api/predict', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: [fullVideoUrl],
            fn_index: 0 // Assuming the video-to-3D function is at index 0
          })
        });
        
        const gradioResult = await gradioResponse.json();
        console.log('🎯 Gradio response:', gradioResult);
        
        if (gradioResult.data && gradioResult.data[0]) {
          const glbUrl = gradioResult.data[0];
          console.log('✅ GLB file generated:', glbUrl);
          
          res.json({
            success: true,
            videoUrl: fullVideoUrl,
            glbUrl: glbUrl,
            message: imageFile ? 
              'Video generated and converted to 3D model!' : 
              'Video generated and converted to 3D model!',
            has3D: true
          });
        } else {
          // Video generated but 3D conversion failed
          res.json({
            success: true,
            videoUrl: fullVideoUrl,
            message: imageFile ? 
              'Video generated! (3D conversion temporarily unavailable)' : 
              'Video generated! (3D conversion temporarily unavailable)',
            has3D: false,
            error3D: 'Gradio server did not return a valid GLB file'
          });
        }
      } catch (gradioError) {
        console.error('❌ Gradio conversion failed:', gradioError);
        
        // Still return the video even if 3D conversion fails
        res.json({
          success: true,
          videoUrl: fullVideoUrl,
          message: imageFile ? 
            'Video generated! (3D conversion temporarily unavailable)' : 
            'Video generated! (3D conversion temporarily unavailable)',
          has3D: false,
          error3D: gradioError.message
        });
      }
    } else {
      console.error('❌ No video URI found in response');
      console.error('Available response keys:', Object.keys(operation.response || {}));
      
      res.status(500).json({
        error: 'No video generated',
        message: 'The API completed but no video URI was returned',
        debug: operation.response
      });
    }

  } catch (error) {
    console.error('Veo 2 API Error:', error);
    
    // If this was an image-to-video request that failed due to overload, try text-only as fallback
    if (imageFile && (error.message?.includes('overloaded') || error.message?.includes('UNAVAILABLE'))) {
      console.log('🔄 Image-to-video failed due to server overload, trying text-only generation as fallback...');
      
      try {
        const fallbackOperation = await ai.models.generateVideos({
          model: "veo-2.0-generate-001",
          prompt: `${prompt} (Originally requested with image but using text-only due to server capacity)`,
          config: {
            personGeneration: "dont_allow",
            aspectRatio: "16:9",
          },
        });
        
        // Poll for completion
        let pollCount = 0;
        const maxPolls = 20;
        
        while (!fallbackOperation.done && pollCount < maxPolls) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          fallbackOperation = await ai.operations.getVideosOperation({ operation: fallbackOperation });
          pollCount++;
          console.log(`Fallback polling attempt ${pollCount}, status: ${fallbackOperation.done ? 'done' : 'pending'}`);
        }
        
        if (fallbackOperation.done) {
          let videoUri = null;
          
          if (fallbackOperation.response?.generatedVideos?.[0]?.video?.uri) {
            videoUri = fallbackOperation.response.generatedVideos[0].video.uri;
          }
          
          if (videoUri) {
            const fullVideoUrl = `${videoUri}&key=${process.env.GEMINI_API_KEY}`;
            
            // Try 3D conversion for fallback video too
            try {
              const gradioResponse = await fetch('https://e887ddc6057cfd219d.gradio.live/api/predict', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  data: [fullVideoUrl],
                  fn_index: 0
                })
              });
              
              const gradioResult = await gradioResponse.json();
              
              if (gradioResult.data && gradioResult.data[0]) {
                return res.json({
                  success: true,
                  videoUrl: fullVideoUrl,
                  glbUrl: gradioResult.data[0],
                  message: 'Video generated from text only and converted to 3D (image-to-video temporarily unavailable)',
                  fallback: true,
                  has3D: true
                });
              }
            } catch (gradioError) {
              console.error('❌ Gradio conversion failed for fallback video:', gradioError);
            }
            
            return res.json({
              success: true,
              videoUrl: fullVideoUrl,
              message: 'Video generated from text only (image-to-video temporarily unavailable)',
              fallback: true,
              has3D: false
            });
          }
        }
      } catch (fallbackError) {
        console.error('❌ Fallback text-only generation also failed:', fallbackError);
      }
    }
    
    // Clean up image if it exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      error: 'Failed to generate video',
      message: error.message,
      details: error.response?.data || 'Unknown error',
      suggestion: imageFile ? 'Try generating without an image (text-only) as image-to-video may be experiencing high demand' : null
    });
  }
});

// Check video status endpoint
app.get('/api/video-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const response = await axios.get(
      `${process.env.VEO3_API_URL?.replace('/generate-preview', '')}/status/${jobId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.VEO3_API_KEY}`
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error checking video status:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to check video status',
      message: error.response?.data?.message || error.message
    });
  }
});

// Proceed to 3D endpoint
app.post('/api/proceed-to-3d', async (req, res) => {
  try {
    const { videoUrl, prompt } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'Video URL is required' });
    }

    // Here you would integrate with your 3D rendering service
    // For now, we'll just return a success response
    console.log('Proceeding to 3D with video:', videoUrl);
    console.log('Original prompt:', prompt);

    res.json({
      success: true,
      message: '3D rendering process initiated',
      videoUrl: videoUrl,
      renderingId: `3d_${Date.now()}`
    });

  } catch (error) {
    console.error('Error proceeding to 3D:', error.message);
    res.status(500).json({
      error: 'Failed to proceed to 3D rendering',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
  }
  res.status(500).json({ error: 'Internal server error' });
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// ------------------------------------------------------------------
//  Google Generative AI (Gemini) client
// ------------------------------------------------------------------
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is not set in the .env file. Please add it before starting the server.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});