import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import { testGiftCardLinking, verifySolutionRequirements } from "../tests/giftCardLinkingTest";

export function GiftCardTest() {
  const [testStatus, setTestStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [testResults, setTestResults] = useState<any>(null);
  const [requirements] = useState(() => verifySolutionRequirements());
  
  const runTests = async () => {
    setTestStatus('running');
    
    try {
      const results = await testGiftCardLinking();
      setTestResults(results);
      setTestStatus(results.success ? 'success' : 'error');
    } catch (error) {
      console.error('Test execution error:', error);
      setTestResults({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      setTestStatus('error');
    }
  };
  
  return (
    <div className="container py-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Gift Card Linking Solution Test</h1>
        
        <Tabs defaultValue="requirements">
          <TabsList className="mb-4">
            <TabsTrigger value="requirements">Requirements</TabsTrigger>
            <TabsTrigger value="test">API Test</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
          </TabsList>
          
          <TabsContent value="requirements">
            <Card>
              <CardHeader>
                <CardTitle>Solution Requirements</CardTitle>
                <CardDescription>
                  Verification of required functionality for the gift card linking solution
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {requirements.map((req, index) => (
                    <li key={index} className="flex items-start">
                      <span className="text-green-600 mr-2">{req.startsWith('✓') ? '✓' : '•'}</span>
                      <span>{req.replace(/^✓\s/, '')}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </TabsContent>
          
          <TabsContent value="test">
            <Card>
              <CardHeader>
                <CardTitle>API Test</CardTitle>
                <CardDescription>
                  Test the gift card linking API endpoints
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="mb-4">
                  This test will verify:
                </p>
                <ul className="list-disc pl-6 mb-6 space-y-1">
                  <li>Gift card analysis API functionality</li>
                  <li>Gift card fix API functionality</li>
                  <li>Accuracy of activation amounts</li>
                  <li>Order linking success rate</li>
                </ul>
                
                {testStatus === 'error' && (
                  <Alert variant="destructive" className="mb-4">
                    <AlertTitle>Test Failed</AlertTitle>
                    <AlertDescription>
                      {testResults?.error || 'An unknown error occurred during testing'}
                    </AlertDescription>
                  </Alert>
                )}
                
                {testStatus === 'success' && (
                  <Alert className="mb-4 bg-green-50 border-green-300">
                    <AlertTitle className="text-green-800">Test Successful</AlertTitle>
                    <AlertDescription className="text-green-700">
                      All components of the gift card linking solution are functioning correctly.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
              <CardFooter className="flex justify-between">
                <Button
                  onClick={runTests}
                  disabled={testStatus === 'running'}
                >
                  {testStatus === 'running' ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Running Test...
                    </>
                  ) : 'Run API Test'}
                </Button>
              </CardFooter>
            </Card>
          </TabsContent>
          
          <TabsContent value="results">
            <Card>
              <CardHeader>
                <CardTitle>Test Results</CardTitle>
                <CardDescription>
                  Detailed output from API tests
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!testResults ? (
                  <div className="p-4 text-center text-gray-500 italic">
                    No test has been run yet. Go to the "API Test" tab to run the test.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <h3 className="font-semibold mb-1">Analysis Results</h3>
                      <Separator className="mb-2" />
                      {testResults.analysisData ? (
                        <pre className="bg-gray-50 p-3 rounded-md text-sm overflow-auto max-h-40">
                          {JSON.stringify(testResults.analysisData, null, 2)}
                        </pre>
                      ) : (
                        <p className="italic text-gray-500">No analysis data available</p>
                      )}
                    </div>
                    
                    <div>
                      <h3 className="font-semibold mb-1">Fix Results</h3>
                      <Separator className="mb-2" />
                      {testResults.fixData ? (
                        <pre className="bg-gray-50 p-3 rounded-md text-sm overflow-auto max-h-40">
                          {JSON.stringify(testResults.fixData, null, 2)}
                        </pre>
                      ) : (
                        <p className="italic text-gray-500">No fix data available</p>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export default GiftCardTest;