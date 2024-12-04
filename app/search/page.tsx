'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invokeSearchAgent } from '@/lib/search-api';
import { Search } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import Link from 'next/link';
import { LoadingDots } from '@/components/loading-dots';

interface Message {
  type: 'user' | 'assistant' | 'error' | 'loading';
  content: string;
  carListings?: CarDetails[];
  sources?: {
    name: string;
    url: string;
    icon?: string;
  }[];
}

interface CarDetails {
  make?: string;
  model?: string;
  year?: string;
  price?: string;
  location?: string;
  description?: string;
  url?: string;
  monthlyFrom?: string;
  mileage?: string;
}

interface SearchResult {
  sources: {
    name: string;
    url: string;
    icon?: string;
  }[];
  answer: string;
  carListings: CarDetails[];
  isInitialQuestion?: boolean;
}

// Define supported car listing websites and their details
const CAR_WEBSITES = {
  carzone: {
    name: "Carzone",
    domain: "carzone.ie",
    baseUrl: "https://www.carzone.ie",
    icon: "/logos/carzone.png"
  },
  donedeal: {
    name: "DoneDeal",
    domain: "donedeal.ie",
    baseUrl: "https://www.donedeal.ie",
    icon: "/logos/donedeal.png"
  },
  carsireland: {
    name: "Cars Ireland",
    domain: "cars.ie",
    baseUrl: "https://www.cars.ie",
    icon: "/logos/carsireland.png"
  }
} as const;

// Helper function to get website details from URL
const getWebsiteFromUrl = (url: string) => {
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return Object.values(CAR_WEBSITES).find(site => 
      domain === site.domain || domain.endsWith('.' + site.domain)
    );
  } catch (error) {
    console.error('Error parsing URL:', error);
    return null;
  }
};

// Parse webhook response to extract car details
const parseCarDetails = (content: string): CarDetails => {
  const details: CarDetails = {};

  // Extract URL - try multiple formats
  const urlPatterns = [
    /\[(?:here|View Listing|.*?)\]\((https?:\/\/[^\s)]+)\)/, // Markdown link [text](url)
    /View the listing: (https?:\/\/[^\s]+)/, // Plain text with prefix
    /Listing URL: (https?:\/\/[^\s]+)/, // Another plain text format
    /You can view this car at: (https?:\/\/[^\s]+)/, // Another variation
    /(https?:\/\/(?:www\.)(?:carzone|donedeal|carsireland)\.ie[^\s]+)/ // Direct URLs from known domains
  ];

  for (const pattern of urlPatterns) {
    const match = content.match(pattern);
    if (match) {
      details.url = match[1];
      break;
    }
  }

  // Extract other details using more flexible patterns
  const patterns = {
    make: /(?:\*\*)?Make(?:\*\*)?:?\s*([^*\n]+)/i,
    model: /(?:\*\*)?Model(?:\*\*)?:?\s*([^*\n]+)/i,
    year: /(?:\*\*)?Year(?:\*\*)?:?\s*([^*\n]+)/i,
    price: /(?:\*\*)?Price(?:\*\*)?:?\s*([^*\n]+)/i,
    location: /(?:\*\*)?Location(?:\*\*)?:?\s*([^*\n]+)/i,
    description: /(?:\*\*)?Description(?:\*\*)?:?\s*([^*\n]+)/i,
    monthlyFrom: /(?:\*\*)?Monthly from(?:\*\*)?:?\s*([^*\n]+)/i,
    mileage: /(?:\*\*)?Mileage(?:\*\*)?:?\s*([^*\n]+)/i
  };

  // Extract each detail using the patterns
  Object.entries(patterns).forEach(([key, pattern]) => {
    const match = content.match(pattern);
    if (match) {
      details[key as keyof CarDetails] = match[1].trim();
    }
  });

  return details;
};

// Custom components for ReactMarkdown
const MarkdownComponents: Partial<Components> = {
  // Handle links with custom styling
  a: ({ node, ...props }) => (
    <a
      {...props}
      className="text-blue-600 hover:text-blue-800 underline"
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
  // Style headings
  h1: ({ node, ...props }) => <h1 {...props} className="text-2xl font-bold mb-4" />,
  h2: ({ node, ...props }) => <h2 {...props} className="text-xl font-bold mb-3" />,
  h3: ({ node, ...props }) => <h3 {...props} className="text-lg font-bold mb-2" />,
  // Style paragraphs
  p: ({ node, ...props }) => <p {...props} className="mb-4 leading-relaxed" />,
  // Style lists
  ul: ({ node, ...props }) => <ul {...props} className="list-disc pl-6 mb-4" />,
  ol: ({ node, ...props }) => <ol {...props} className="list-decimal pl-6 mb-4" />,
  li: ({ node, ...props }) => <li {...props} className="mb-1" />,
  // Style code blocks and inline code
  code: ({ node, inline, ...props }) => (
    <code
      {...props}
      className={`${
        inline
          ? 'bg-gray-100 rounded px-1 py-0.5'
          : 'block bg-gray-100 rounded-lg p-4 mb-4'
      }`}
    />
  ),
  // Style blockquotes
  blockquote: ({ node, ...props }) => (
    <blockquote
      {...props}
      className="border-l-4 border-gray-200 pl-4 italic mb-4"
    />
  ),
  // Style tables
  table: ({ node, ...props }) => (
    <table {...props} className="min-w-full divide-y divide-gray-200 mb-4" />
  ),
  th: ({ node, ...props }) => (
    <th
      {...props}
      className="px-6 py-3 bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
    />
  ),
  td: ({ node, ...props }) => (
    <td {...props} className="px-6 py-4 whitespace-nowrap text-sm text-gray-900" />
  ),
};

// Parse webhook response to extract car details and structure the response
const parseResponse = (content: string): Message => {
  // Split content into sections based on markdown headings
  const sections = content.split(/(?=^#{1,3} )/m);
  
  let mainContent = content;
  let carDetails: CarDetails | null = null;
  const sources: Message['sources'] = [];

  // Process each section
  sections.forEach(section => {
    const heading = section.match(/^#{1,3} (.+)$/m)?.[1]?.toLowerCase();
    
    if (heading?.includes('car details') || heading?.includes('listing details')) {
      carDetails = parseCarDetails(section);
    } else if (heading?.includes('source') || heading?.includes('from')) {
      // Extract sources from the section
      const urlMatches = section.match(/\[([^\]]+)\]\(([^)]+)\)/g);
      urlMatches?.forEach(match => {
        const [_, name, url] = match.match(/\[([^\]]+)\]\(([^)]+)\)/) || [];
        if (name && url) {
          const website = getWebsiteFromUrl(url);
          sources.push({
            name: website?.name || name,
            url,
            icon: website?.icon
          });
        }
      });
    }
  });

  // If no explicit sources were found but we have a car URL, use it as source
  if (sources.length === 0 && carDetails?.url) {
    const website = getWebsiteFromUrl(carDetails.url);
    if (website) {
      sources.push({
        name: website.name,
        url: website.baseUrl,
        icon: website.icon
      });
    }
  }

  return {
    type: 'assistant',
    content: mainContent,
    carListings: carDetails ? [carDetails] : undefined,
    sources: sources.length > 0 ? sources : undefined
  };
};

export default function SearchPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId') || uuidv4();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Get all selected values from URL params
  const selectedParams = {
    make: searchParams.get('make'),
    model: searchParams.get('model'),
    location: searchParams.get('location'),
    minPrice: searchParams.get('minPrice'),
    maxPrice: searchParams.get('maxPrice'),
    minYear: searchParams.get('minYear'),
    maxYear: searchParams.get('maxYear'),
    features: searchParams.get('features')?.split(',') || [],
    usage: searchParams.get('usage'),
  };

  useEffect(() => {
    let isMounted = true;

    async function performSearch() {
      try {
        const chatInput = searchParams.get('chatInput');
        if (!chatInput) return;

        const carSpecs = {
          make: selectedParams.make || undefined,
          model: selectedParams.model || undefined,
          year: selectedParams.minYear ? parseInt(selectedParams.minYear) : undefined,
          county: selectedParams.location || undefined,
          features: selectedParams.features,
          usage: selectedParams.usage || undefined,
          minPrice: selectedParams.minPrice ? parseInt(selectedParams.minPrice) : undefined,
          maxPrice: selectedParams.maxPrice ? parseInt(selectedParams.maxPrice) : undefined,
        };

        const response = await invokeSearchAgent({
          sessionId,
          chatInput,
          carSpecs,
        });

        if (isMounted && response?.message) {
          const parsedMessage = parseResponse(response.message);
          setMessages([parsedMessage]);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error in search process:', error);
        if (isMounted) {
          setMessages([{
            type: 'error',
            content: 'Sorry, there was an error processing your request. Please try again.'
          }]);
          setIsLoading(false);
        }
      }
    }

    performSearch();

    return () => {
      isMounted = false;
    };
  }, [sessionId]);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    // Add user message immediately
    setMessages(prev => [...prev, { type: 'user', content: chatInput }]);
    
    // Clear input and set loading
    setChatInput('');
    setIsLoading(true);

    // Add temporary loading message
    setMessages(prev => [...prev, { type: 'loading', content: '' }]);

    try {
      // Prepare car specs from URL parameters
      const carSpecs = {
        make: selectedParams.make || undefined,
        model: selectedParams.model || undefined,
        year: selectedParams.minYear ? parseInt(selectedParams.minYear) : undefined,
        county: selectedParams.location || undefined,
        features: selectedParams.features,
        usage: selectedParams.usage || undefined,
        minPrice: selectedParams.minPrice ? parseInt(selectedParams.minPrice) : undefined,
        maxPrice: selectedParams.maxPrice ? parseInt(selectedParams.maxPrice) : undefined,
      };

      const response = await invokeSearchAgent({
        sessionId,
        chatInput,
        carSpecs,
      });

      // Remove loading message and add response
      setMessages(prev => prev.filter(msg => msg.type !== 'loading').concat({
        type: 'assistant',
        content: response.message,
        carListings: response.carListings,
        sources: response.sources
      }));
    } catch (error) {
      // Remove loading message and add error
      setMessages(prev => prev.filter(msg => msg.type !== 'loading').concat({
        type: 'error',
        content: 'Sorry, there was an error processing your request.'
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const renderMessage = (message: Message) => {
    if (message.type === 'loading') {
      return (
        <div className="flex py-4 px-4">
          <div className="bg-gray-50/50 rounded-lg px-4 py-2">
            <LoadingDots />
          </div>
        </div>
      );
    }

    return (
      <div className="flex px-4 py-4">
        <div className={`w-full max-w-3xl rounded-lg px-4 py-3 ${
          message.type === 'user' 
            ? 'bg-blue-50/50 text-gray-800' 
            : message.type === 'error'
            ? 'bg-red-50 text-red-500 border border-red-100'
            : 'bg-gray-50/50'
        }`}>
          {message.type === 'assistant' ? (
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm">{message.content}</p>
          )}
        </div>
      </div>
    );
  };

  // Render selected parameters as badges
  const renderBadges = () => (
    <div className="flex flex-wrap gap-2 mb-6">
      {Object.entries(selectedParams).map(([key, value]) => {
        if (!value || (Array.isArray(value) && value.length === 0)) return null;
        if (key === 'chatInput') return null;
        if (Array.isArray(value)) {
          return value.map((v, i) => (
            <span key={`${key}-${i}`} className="px-3 py-1 text-sm bg-gray-100 rounded-full">
              {v}
            </span>
          ));
        }
        return (
          <span key={key} className="px-3 py-1 text-sm bg-gray-100 rounded-full">
            {value}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-screen bg-white">
      <div className="flex-1 relative">
        <div className="absolute inset-0 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#E5E7EB transparent' }}>
          <div className="max-w-4xl mx-auto py-8">
            {/* Search Parameters as Badges */}
            <div className="px-4">
              {renderBadges()}
            </div>

            {/* Chat Messages */}
            <div className="space-y-1">
              {messages.map((message, index) => (
                <div key={index} className="animate-fadeIn">
                  {renderMessage(message)}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Bottom Padding for Chat Input */}
            <div className="h-32" />
          </div>
        </div>

        {/* Fixed Chat Input */}
        <div className="fixed bottom-0 inset-x-0 ml-12 transition-all duration-300">
          <div className="max-w-4xl mx-auto">
            <div className="mx-4 mb-4 bg-white border shadow-sm rounded-lg">
              <form onSubmit={handleChatSubmit} className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  <Search size={20} />
                </div>
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask follow up..."
                  className="w-full bg-transparent rounded-lg pl-10 pr-20 py-3 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:hover:bg-blue-500"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
