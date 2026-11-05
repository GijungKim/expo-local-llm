import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View, ScrollView, ActivityIndicator, Image, useWindowDimensions } from 'react-native';
import { Asset } from 'expo-asset';
import { useLocalLLM, type Schema } from 'expo-local-llm';

const recipeSchema: Schema = {
  name: { type: 'string', description: 'Recipe name' },
  ingredients: {
    type: 'array',
    items: { type: 'string' },
    description: 'List of ingredients',
  },
  steps: {
    type: 'array',
    items: { type: 'string' },
    description: 'Cooking steps in order',
  },
  difficulty: {
    type: 'string',
    enum: ['easy', 'medium', 'hard'],
    description: 'How hard the recipe is to cook',
  },
};

const imageSample = require('./assets/image-sample.png');
const imageQuestion = 'Describe the shapes and their colors, from left to right.';

type Mode = 'chat' | 'json' | 'image';

export default function App() {
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<Mode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const {
    availability,
    isGenerating,
    streamedText,
    streamedJSON,
    streamedObject,
    error,
    streamResponse,
    cancelStream,
    downloadModel,
    downloadProgress,
  } = useLocalLLM(
    mode === 'json'
      ? {
          instructions: 'You generate recipes as structured JSON.',
          responseFormat: 'json',
          schema: recipeSchema,
        }
      : {
          instructions: mode === 'image'
            ? 'Describe only what you can see in the attached image. Keep the answer to two sentences.'
            : 'You are a helpful health assistant. Keep responses concise.',
        }
  );

  const handleSend = async () => {
    if (!input.trim() || !streamResponse) return;
    const prompt = input.trim();
    setInput('');
    if (mode === 'chat') {
      setMessages((prev) => [...prev, { role: 'user', text: prompt }]);
    }
    try {
      await streamResponse(prompt);
    } catch {}
  };

  const handleDescribeImage = async () => {
    if (!streamResponse || isPreparingImage || isGenerating) return;
    setIsPreparingImage(true);
    setImageError(null);
    try {
      const asset = Asset.fromModule(imageSample);
      await asset.downloadAsync();
      if (!asset.localUri) throw new Error('The sample image is not available locally.');
      setIsPreparingImage(false);
      await streamResponse({
        text: imageQuestion,
        images: [{ uri: asset.localUri, label: 'sample' }],
      });
    } catch (failure) {
      setImageError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setIsPreparingImage(false);
    }
  };

  React.useEffect(() => {
    if (mode !== 'chat') return;
    if (!isGenerating && streamedText) {
      setMessages((prev) => {
        if (prev[prev.length - 1]?.role === 'assistant' && prev[prev.length - 1]?.text === streamedText) {
          return prev;
        }
        return [...prev, { role: 'assistant', text: streamedText }];
      });
    }
  }, [isGenerating, streamedText, mode]);

  const jsonPretty = streamedObject
    ? JSON.stringify(streamedObject, null, 2)
    : streamedJSON || '';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>expo-local-llm</Text>
        <Text style={styles.status}>Status: {availability}</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        {availability === 'downloadRequired' && downloadModel && (
          <TouchableOpacity style={styles.downloadBtn} onPress={downloadModel}>
            <Text style={styles.downloadBtnText}>
              {downloadProgress != null ? `Downloading ${Math.round(downloadProgress * 100)}%` : 'Download Model'}
            </Text>
          </TouchableOpacity>
        )}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, mode === 'chat' && styles.tabActive]}
            onPress={() => setMode('chat')}
            disabled={isGenerating || isPreparingImage}
          >
            <Text style={[styles.tabText, mode === 'chat' && styles.tabTextActive]}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, mode === 'json' && styles.tabActive]}
            onPress={() => setMode('json')}
            disabled={isGenerating || isPreparingImage}
          >
            <Text style={[styles.tabText, mode === 'json' && styles.tabTextActive]}>JSON (recipe)</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, mode === 'image' && styles.tabActive]}
            onPress={() => setMode('image')}
            disabled={isGenerating || isPreparingImage}
          >
            <Text style={[styles.tabText, mode === 'image' && styles.tabTextActive]}>Image</Text>
          </TouchableOpacity>
        </View>
      </View>

      {mode === 'image' ? (
        <ScrollView style={styles.messages} contentContainerStyle={styles.imageContent}>
          <Image
            source={imageSample}
            style={[styles.sampleImage, { width: width - 32, height: (width - 32) * 340 / 600 }]}
            resizeMode="contain"
            accessibilityLabel="Image sent to the local model"
          />
          <Text style={styles.imageQuestion}>{imageQuestion}</Text>
          {imageError && <Text style={styles.error}>{imageError}</Text>}
          {streamedText ? <Text style={styles.imageAnswer}>{streamedText}</Text> : null}
          {(isGenerating || isPreparingImage) && !streamedText ? <ActivityIndicator /> : null}
        </ScrollView>
      ) : mode === 'chat' ? (
        <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent}>
          {messages.map((msg, i) => (
            <View key={i} style={[styles.bubble, msg.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
              <Text style={msg.role === 'user' ? styles.userText : styles.assistantText}>{msg.text}</Text>
            </View>
          ))}
          {isGenerating && streamedText ? (
            <View style={[styles.bubble, styles.assistantBubble]}>
              <Text style={styles.assistantText}>{streamedText}</Text>
            </View>
          ) : null}
          {isGenerating && !streamedText ? <ActivityIndicator style={styles.loader} /> : null}
        </ScrollView>
      ) : (
        <ScrollView style={styles.messages} contentContainerStyle={styles.jsonContent}>
          {!jsonPretty && !isGenerating ? (
            <Text style={styles.hint}>
              Try: "Italian dinner", "Quick breakfast", "Vegan dessert"{'\n'}
              {'\n'}
              Watch the JSON fill in field-by-field as the model generates.
            </Text>
          ) : (
            <Text style={styles.jsonText}>{jsonPretty}</Text>
          )}
          {isGenerating && !jsonPretty ? <ActivityIndicator style={styles.loader} /> : null}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        {mode !== 'image' && <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={mode === 'json' ? 'What kind of recipe?' : 'Ask something...'}
          editable={!isGenerating}
        />}
        {isGenerating ? (
          <TouchableOpacity style={styles.sendBtn} onPress={cancelStream}>
            <Text style={styles.sendBtnText}>Stop</Text>
          </TouchableOpacity>
        ) : mode === 'image' ? (
          <TouchableOpacity
            style={[styles.sendBtn, styles.imageButton]}
            onPress={handleDescribeImage}
            disabled={isPreparingImage || !streamResponse || availability !== 'available'}
          >
            <Text style={styles.sendBtnText}>Describe image</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={!input.trim() || !streamResponse}>
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f7' },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  title: { fontSize: 20, fontWeight: '700', color: '#1c1c1e' },
  status: { fontSize: 13, color: '#888', marginTop: 4 },
  error: { fontSize: 13, color: '#ff3b30', marginTop: 4 },
  downloadBtn: { marginTop: 8, backgroundColor: '#007aff', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16, alignSelf: 'flex-start' },
  downloadBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  tabRow: { flexDirection: 'row', marginTop: 12, gap: 8 },
  tab: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: '#f0f0f0' },
  tabActive: { backgroundColor: '#1c1c1e' },
  tabText: { fontSize: 13, color: '#666', fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 8 },
  jsonContent: { padding: 16 },
  imageContent: { padding: 16, gap: 16 },
  sampleImage: { backgroundColor: '#fff', borderRadius: 12 },
  imageQuestion: { fontSize: 15, color: '#666', lineHeight: 22 },
  imageAnswer: { fontSize: 17, color: '#1c1c1e', lineHeight: 25, backgroundColor: '#fff', padding: 16, borderRadius: 12 },
  imageButton: { flex: 1, alignItems: 'center', minHeight: 44 },
  jsonText: { fontFamily: 'Menlo', fontSize: 13, color: '#1c1c1e' },
  hint: { fontSize: 14, color: '#888', lineHeight: 20 },
  bubble: { padding: 12, borderRadius: 16, maxWidth: '80%' },
  userBubble: { backgroundColor: '#007aff', alignSelf: 'flex-end' },
  assistantBubble: { backgroundColor: '#fff', alignSelf: 'flex-start' },
  userText: { color: '#fff', fontSize: 15 },
  assistantText: { color: '#1c1c1e', fontSize: 15 },
  loader: { alignSelf: 'flex-start', marginVertical: 8 },
  inputRow: { flexDirection: 'row', padding: 12, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0', gap: 8 },
  input: { flex: 1, backgroundColor: '#f0f0f0', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  sendBtn: { backgroundColor: '#007aff', borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
