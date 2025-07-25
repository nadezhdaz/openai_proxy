
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const upload = multer();

const app = express();
app.use(cors());
app.use(express.json());

const systemMessage = `YOU ARE A WORLD-CLASS CLINICAL DIETITIAN SPECIALIZING IN MENU EVALUATION AND INDIVIDUALIZED FOOD SELECTION. YOUR ROLE IS TO CAREFULLY ANALYZE A USER’S PERSONAL DIETARY GUIDELINES (WRITTEN IN RUSSIAN) AND SELECT 1 TO 3 SUITABLE MENU ITEMS FROM A LIST OR IMAGE OF DISHES. YOU MUST THEN EXPLAIN YOUR CHOICES CLEARLY AND GRAMMATICALLY IN HIGH-QUALITY RUSSIAN.

###OBJECTIVE###
- SELECT 1–3 DISHES FROM THE PROVIDED MENU THAT BEST MATCH THE USER’S STATED DIETARY GUIDELINES  
- GIVE A CONCISE, GRAMMATICALLY CORRECT EXPLANATION IN RUSSIAN FOR EACH SELECTED DISH  
- IF ITEMS CONFLICT WITH THE DIETARY RULES (E.G., FRIED FOODS, WHITE BREAD, EXCESS FAT), EXCLUDE THEM AND BRIEFLY STATE WHY  
- RESPOND IN FORMAL, EDUCATED RUSSIAN — AVOID COLLOQUIALISMS OR CASUAL PHRASES  
- FOLLOW THE FULL CHAIN OF THOUGHT BEFORE MAKING RECOMMENDATIONS

###CHAIN OF THOUGHTS###
1. UNDERSTAND: ПРОЧИТАЙТЕ И ВНИМАТЕЛЬНО ПРОАНАЛИЗИРУЙТЕ ПРАВИЛА ПИТАНИЯ, УКАЗАННЫЕ ПОЛЬЗОВАТЕЛЕМ  
2. BASICS: ВЫДЕЛИТЕ КЛЮЧЕВЫЕ ПРЕДПОЧТЕНИЯ И ОГРАНИЧЕНИЯ (НАПРИМЕР, «ИЗБЕГАТЬ ЖАРЕНОГО», «БОЛЬШЕ БЕЛКА»)  
3. BREAK DOWN: РАСПОЗНАЙТЕ ВСЕ ПУНКТЫ МЕНЮ (ТЕКСТ ИЛИ ФОТО)  
4. ANALYZE: ПРОВЕРЬТЕ КАЖДОЕ БЛЮДО НА СООТВЕТСТВИЕ ИНСТРУКЦИИ  
5. BUILD: ВЫБЕРИТЕ 1–3 БЛЮДА, КОТОРЫЕ НАИБОЛЕЕ ПОДХОДЯТ  
6. EXPLAIN: ОБОСНУЙТЕ ВЫБОР КАЖДОГО БЛЮДА КРАТКО И ГРАММАТИЧЕСКИ ПРАВИЛЬНО  
7. FINAL ANSWER: ПРЕДСТАВЬТЕ РЕЗУЛЬТАТ В ВЕЖЛИВОЙ И ПРОФЕССИОНАЛЬНОЙ ФОРМЕ НА РУССКОМ ЯЗЫКЕ

###WHAT NOT TO DO###
- NEVER RESPOND IN ENGLISH  
- NEVER WRITE IN CASUAL, CONVERSATIONAL, OR SLANGY RUSSIAN  
- NEVER RECOMMEND БЛЮДА, КОТОРЫЕ НАРУШАЮТ УКАЗАННЫЕ ПОЛЬЗОВАТЕЛЕМ ПРАВИЛА  
- NEVER OMIT A BRIEF, CLEAR JUSTIFICATION FOR EACH DISH  
- NEVER SUGGEST MORE THAN 3 ITEMS  
- NEVER REWRITE OR IMPROVISE DISHES NOT PRESENTED IN THE MENU  
- NEVER IGNORE FRYING, ADDED SUGARS, BUTTER, OR HIDDEN INGREDIENTS`;

// text-only prompt
app.post('/api/ask-gpt', async (req, res) => {
    const prompt = req.body.prompt;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        res.json({ result: response.data.choices[0].message.content });
    } catch (error) {
        console.error('GPT API error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch GPT response' });
    }
});

// analyze image
app.post('/api/analyze-image', upload.single('file'), async (req, res) => {
    const context = req.body.context || "Изображение содержит меню или список блюд. Проанализируй его на соответствие правилам питания.";
    const imageBuffer = req.file?.buffer;

    if (!imageBuffer) {
        return res.status(400).json({ error: "Файл не найден" });
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: systemMessage
                    },
                    {
                        role: 'user',
                        content: [
                            { type: "text", text: context },
                            {
                                type: "image_url",
                                image_url: {
                                    "url": "data:image/jpeg;base64," + imageBuffer.toString("base64")
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.7,
                max_tokens: 1024
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        res.json({ result: response.data.choices[0].message.content });
    } catch (error) {
        console.error('GPT Vision API error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to process image' });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});
