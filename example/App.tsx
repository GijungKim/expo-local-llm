import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalLLM } from 'expo-local-llm';

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);

  const {
    availability,
    isGenerating,
    streamedText,
    error,
    respond,
    streamResponse,
    cancelStream,
    downloadModel,
    downloadProgress,
  } = useLocalLLM({
    instructions: 'You are a helpful health assistant. Keep responses concise.',
  });

  const handleSend = async () => {
    if (!input.trim() || !streamResponse) return;
    const prompt = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: prompt }]);

    try {
      await streamResponse(prompt);
    } catch {}
  };

  const handleComplete = () => {
    if (streamedText) {
      setMessages((prev) => [...prev, { role: 'assistant', text: streamedText }]);
    }
  };

  // When streaming completes, add message
  React.useEffect(() => {
    if (!isGenerating && streamedText) {
      handleComplete();
    }
  }, [isGenerating]);

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
      </View>

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

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask something..."
          editable={!isGenerating}
        />
        {isGenerating ? (
          <TouchableOpacity style={styles.sendBtn} onPress={cancelStream}>
            <Text style={styles.sendBtnText}>Stop</Text>
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
  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 8 },
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
