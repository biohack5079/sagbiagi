---
title: Plower
emoji: 🐢
colorFrom: gray
colorTo: gray
sdk: docker
pinned: false
app_port: 7860
---

# Plower

Plower is a local-first LLM application designed as a privacy-conscious alternative
to cloud-based tools such as NotebookLM.

The project focuses on integrating large language models into practical workflows
while explicitly considering hardware constraints and system trade-offs.

## Overview

Plower enables users to interact with documents and pasted text using LLMs,
while keeping data easily accessible and stored locally.

The system supports multiple model backends, allowing users to choose between
Google Gemma 3 models (INT4 optimized) and GPT-based models depending on their requirements.

## Key Design Principles

### Local-First Approach

A local-first design was chosen to prioritize:

- **Data privacy**: User content remains easily accessible and controllable.
- **Flexibility**: Text and documents can be stored and reused locally without
  reliance on external services.
- **Transparency**: Model behavior and performance trade-offs are visible to the user.

### Model Selection Flexibility

Plower allows switching between different LLM backends:

- Google Gemma models
- GPT-based models

This design enables comparison of response quality, performance, and resource usage,
making model selection an explicit part of the user workflow.

## System Trade-offs

Running LLMs locally introduces significant constraints:

- Higher hardware requirements
- Longer inference times compared to cloud-based systems

These limitations were treated as explicit design constraints rather than flaws.
The system was designed with future improvements in model efficiency and inference
environments in mind.
We use INT4 (4-bit) quantization to ensure stability on environments with limited RAM (e.g., Hugging Face Spaces).

## Technologies

- Python
- Local LLM runtimes
- Google Gemma 3 (Multimodal)
- GPT-based models
